import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { initArchive } from '../src/lib/archive-api.ts';
import { createCommandReport, createCommandReporter, createFinding } from '../src/lib/reporting.ts';
import { createRepositoryHost } from '../src/lib/repository-host.ts';
import { sanitizeMessage } from '../src/lib/secret-safety.ts';

// An opaque credential: no provider prefix, so only its position can mark it as secret.
const ECHOED = 'opaque-fixture-value-7f3a9c';

let fetchMock: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;
const installFetch = (
	handler: (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => Promise<Response>,
): void => {
	fetchMock?.mockRestore();
	const replacement = Object.assign(handler, { preconnect: globalThis.fetch.preconnect });
	fetchMock = spyOn(globalThis, 'fetch').mockImplementation(replacement);
};

const temporaryRoots: string[] = [];
afterEach(() => {
	fetchMock?.mockRestore();
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

// A GitHub 401 whose JSON body echoes the request's own Authorization header back, as a proxy or
// a misbehaving upstream can. The header value is read from the real request Octokit sent.
const installEchoingRejection = (status: number, headers: Record<string, string> = {}): void => {
	installFetch(async (_input, init) => {
		const authorization = new Headers(init?.headers).get('authorization') ?? '';
		expect(authorization).toContain(ECHOED);
		return Response.json(
			{
				message: 'Bad credentials',
				request: { headers: { authorization }, nested: JSON.stringify({ authorization }) },
			},
			{ headers, status },
		);
	});
};

const captureStreams = (operation: () => void): string => {
	const lines: string[] = [];
	const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
		lines.push(args.map(String).join(' '));
	});
	const error = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
		lines.push(args.map(String).join(' '));
	});
	try {
		operation();
	} finally {
		log.mockRestore();
		error.mockRestore();
	}
	return lines.join('\n');
};

describe('GitHub adapter error boundary', () => {
	test('reports only the status and operation when a rejection echoes the credential', async () => {
		installEchoingRejection(401);
		const failure = createRepositoryHost('github.com', ECHOED).authenticate();
		await expect(failure).rejects.toThrow(
			'GitHub API request failed (HTTP 401) while reading the authenticated account.',
		);
		const err: unknown = await failure.catch((caught: unknown) => caught);
		expect((err as { status?: unknown }).status).toBe(401);
		expect(String((err as Error).message)).not.toContain(ECHOED);
	});

	test('keeps the rate-limit reset and names the repository being resolved', async () => {
		installEchoingRejection(403, {
			'x-ratelimit-remaining': '0',
			'x-ratelimit-reset': '1800000000',
		});
		await expect(
			createRepositoryHost('github.com', ECHOED).resolve('octo', 'demo'),
		).rejects.toThrow(
			'GitHub API request failed (HTTP 403) while resolving octo/demo. ' +
				'The rate limit is exhausted until 2027-01-15T08:00:00.000Z.',
		);
	});

	test('falls back to the untimed note when the reset is outside the Date range', async () => {
		installEchoingRejection(403, {
			'x-ratelimit-remaining': '0',
			'x-ratelimit-reset': String(Number.MAX_SAFE_INTEGER),
		});
		await expect(createRepositoryHost('github.com', ECHOED).listStars()).rejects.toThrow(
			'GitHub API request failed (HTTP 403) while listing starred repositories. ' +
				'The rate limit is exhausted.',
		);
	});

	test('init reports and JSON output carry no echoed credential', async () => {
		installEchoingRejection(401);
		const targetPath = mkdtempSync(path.join(tmpdir(), 'starsync-provider-error-'));
		temporaryRoots.push(targetPath);
		const report = await initArchive({ targetPath, token: ECHOED });
		expect(report.exitCode).toBe(1);
		expect(report.findings.map((finding) => finding.code)).toEqual([
			'host-authentication-failed',
		]);
		const output = captureStreams(() => createCommandReporter(true).emit(report));
		expect(output).toContain('HTTP 401');
		expect(output).not.toContain(ECHOED);
	});
});

describe('quoted secret field redaction', () => {
	test('redacts quoted secret fields in complete JSON and keeps it valid', () => {
		const message = JSON.stringify({
			access_token: ECHOED,
			Authorization: `token ${ECHOED}`,
			documentation_url: 'https://docs.github.com/rest',
			login: 'some_user',
			token_type: 'bearer',
		});
		const sanitized = sanitizeMessage(message);
		expect(sanitized).not.toContain(ECHOED);
		expect(JSON.parse(sanitized)).toEqual({
			access_token: '[REDACTED]',
			Authorization: '[REDACTED]',
			documentation_url: 'https://docs.github.com/rest',
			login: 'some_user',
			token_type: 'bearer',
		});
	});

	test('redacts quoted secret fields in JSON nested inside JSON strings', () => {
		const inner = JSON.stringify({
			authorization: `token ${ECHOED}`,
			message: 'Bad credentials',
		});
		const twice = JSON.stringify({ body: JSON.stringify({ request: inner }) });
		const sanitized = sanitizeMessage(`HttpError: ${twice}`);
		expect(sanitized).not.toContain(ECHOED);
		const outer = JSON.parse(sanitized.slice('HttpError: '.length)) as { body: string };
		const middle = JSON.parse(outer.body) as { request: string };
		expect(JSON.parse(middle.request)).toEqual({
			authorization: '[REDACTED]',
			message: 'Bad credentials',
		});
	});

	test('matches camelCase and other secret names by suffix, top level and nested', () => {
		const secrets = {
			accessToken: ECHOED,
			auth: ECHOED,
			clientSecret: ECHOED,
			cookie: ECHOED,
			private_key: ECHOED,
			refreshToken: ECHOED,
			secret_access_key: ECHOED,
			'Set-Cookie': ECHOED,
			userPassword: ECHOED,
		};
		const ordinary = { author: 'some_user', monkey: 'banana', tokenType: 'bearer' };
		const redacted = Object.fromEntries(Object.keys(secrets).map((key) => [key, '[REDACTED]']));
		const top = sanitizeMessage(JSON.stringify({ ...secrets, ...ordinary }));
		expect(top).not.toContain(ECHOED);
		expect(JSON.parse(top)).toEqual({ ...redacted, ...ordinary });
		const nested = sanitizeMessage(JSON.stringify({ body: JSON.stringify(secrets) }));
		expect(nested).not.toContain(ECHOED);
		expect(JSON.parse((JSON.parse(nested) as { body: string }).body)).toEqual(redacted);
	});

	test('keeps JSON valid when plain-text credentials sit inside a JSON string', () => {
		const cases = [
			[`request had authorization: token ${ECHOED}`, 'request had authorization: [REDACTED]'],
			[`Bearer ${ECHOED}`, 'Bearer [REDACTED]'],
			[
				`password="${ECHOED}" and token=${ECHOED}`,
				'password=[REDACTED] and token=[REDACTED]',
			],
			[`authorization:\ttoken ${ECHOED}`, 'authorization:\t[REDACTED]'],
			[`x\r\nAuthorization: token ${ECHOED}`, 'x\r\nAuthorization: [REDACTED]'],
			[`Bearer\t${ECHOED}`, 'Bearer\t[REDACTED]'],
			[`password=\t${ECHOED}`, 'password=\t[REDACTED]'],
		] as const;
		for (const [msg, expected] of cases) {
			const top = sanitizeMessage(JSON.stringify({ keep: 'yes', msg, n: 1 }));
			expect(top).not.toContain(ECHOED);
			expect(JSON.parse(top)).toEqual({ keep: 'yes', msg: expected, n: 1 });
			const nested = sanitizeMessage(
				JSON.stringify({ body: JSON.stringify({ keep: 'yes', msg }) }),
			);
			expect(nested).not.toContain(ECHOED);
			expect(JSON.parse((JSON.parse(nested) as { body: string }).body)).toEqual({
				keep: 'yes',
				msg: expected,
			});
		}
	});

	test('keeps JSON valid when a secret property holds a number, a boolean or null', () => {
		const value = { keep: 'yes', password: 482193, pin: 7, secret: true, token: null };
		const top = sanitizeMessage(JSON.stringify(value));
		expect(top).not.toContain('482193');
		expect(JSON.parse(top)).toEqual({ ...value, password: '[REDACTED]' });
		const nested = sanitizeMessage(JSON.stringify({ body: JSON.stringify(value) }));
		expect(nested).not.toContain('482193');
		expect(JSON.parse((JSON.parse(nested) as { body: string }).body)).toEqual({
			...value,
			password: '[REDACTED]',
		});
	});

	test('matches a property by its decoded name when the name is written with escapes', () => {
		// The backslash is built rather than typed, so the fixture holds a real JSON escape: the
		// names below read as authorization and login only once decoded.
		const backslash = String.fromCharCode(92);
		const escaped = `{"${backslash}u0061uthorization":"token ${ECHOED}","log${backslash}u0069n":"some_user"}`;
		expect(escaped).not.toContain('authorization');
		const top = sanitizeMessage(escaped);
		expect(top).not.toContain(ECHOED);
		expect(JSON.parse(top)).toEqual({ authorization: '[REDACTED]', login: 'some_user' });
		const nested = sanitizeMessage(JSON.stringify({ body: escaped }));
		expect(nested).not.toContain(ECHOED);
		expect(JSON.parse((JSON.parse(nested) as { body: string }).body)).toEqual({
			authorization: '[REDACTED]',
			login: 'some_user',
		});
	});

	test('redacts a value with escaped quotes and backslashes in full', () => {
		const message = JSON.stringify({ password: `a"${ECHOED}\\"b`, user: 'some_user' });
		const sanitized = sanitizeMessage(message);
		expect(sanitized).not.toContain(ECHOED);
		expect(JSON.parse(sanitized)).toEqual({ password: '[REDACTED]', user: 'some_user' });
	});

	test('the CLI reporter redacts a quoted field inside a nested provider body', () => {
		const body = JSON.stringify({ headers: { Authorization: `token ${ECHOED}` } });
		const report = createCommandReport({
			command: 'init',
			exitCode: 1,
			findings: [
				createFinding('error', 'host-authentication-failed', `Upstream said ${body}`),
			],
			targetPath: null,
		});
		const output = captureStreams(() => createCommandReporter(true).emit(report));
		expect(output).not.toContain(ECHOED);
		expect(output).toContain('Authorization');
	});
});
