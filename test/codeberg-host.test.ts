import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { initArchive } from '../src/lib/archive-api.ts';
import { parseArchiveConfig } from '../src/lib/archive-config.ts';
import { parseHostArgs } from '../src/lib/cli-host.ts';
import { createCommandReporter } from '../src/lib/reporting.ts';
import { createRepositoryHost } from '../src/lib/repository-host.ts';
import { parseGitHubRepositorySlug } from '../src/lib/repository-resolution.ts';

// An opaque, Codeberg-shaped credential with no recognizable prefix, so nothing but the
// decoder's fixed message keeps it out of reports. It is a single identifier, because Bun's JSON
// parse error quotes the first bare identifier it meets.
const ECHOED = 'opaquecodebergfixture4c1d8e';

// A success status whose body is not JSON: it echoes the request's own token as a bare value, so
// the parser's error message carries the credential unless the decoder replaces it.
const echoingNonJson = (
	_input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1],
) => {
	const token = (new Headers(init?.headers).get('Authorization') ?? '').replace(/^token /, '');
	return Promise.resolve(new Response(`{"echo": ${token}}`, { status: 200 }));
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

const temporaryRoots: string[] = [];

const repository = (id: number) => ({
	clone_url: `https://codeberg.org/example/repo-${id}.git`,
	default_branch: 'trunk',
	full_name: `example/repo-${id}`,
	id,
	name: `repo-${id}`,
});

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
afterEach(() => {
	fetchMock?.mockRestore();
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('Codeberg host contract', () => {
	test('follows short pages until exhaustion and resolves stable IDs', async () => {
		const routes: string[] = [];
		installFetch(async (input, init) => {
			const url = new URL(String(input));
			expect(url.origin).toBe('https://codeberg.org');
			expect(new Headers(init?.headers).get('Authorization')).toBe('token fixture-only');
			expect(init?.redirect).toBe('error');
			routes.push(url.pathname + url.search);
			if (url.pathname.endsWith('/user')) return Response.json({ id: 7, login: 'some_user' });
			if (url.pathname.includes('/repositories/')) return Response.json(repository(3));
			const page = Number(url.searchParams.get('page'));
			return Response.json(page < 3 ? [repository(page)] : []);
		});
		const host = createRepositoryHost('codeberg.org', 'fixture-only');
		expect(await host.authenticate()).toEqual({ id: 7, login: 'some_user' });
		expect((await host.listStars()).map((item) => item.id)).toEqual([1, 2]);
		expect(await host.resolve('old', 'gone', 3)).toEqual({
			id: 3,
			name: 'repo-3',
			owner: 'example',
			slug: 'example/repo-3',
		});
		expect(routes.at(-1)).toBe('/api/v1/repositories/3');
	});

	test('fails closed on repeated pagination and malformed responses', async () => {
		installFetch(async () => Response.json([repository(1)]));
		await expect(
			createRepositoryHost('codeberg.org', 'fixture-only').listStars(),
		).rejects.toThrow('pagination');
		installFetch(async () => Response.json({ error: 'not a list' }));
		await expect(
			createRepositoryHost('codeberg.org', 'fixture-only').listStars(),
		).rejects.toThrow('stars response');
	});

	test('never includes a failed API response body or credentials in errors', async () => {
		installFetch(async () => new Response('fixture-secret', { status: 401 }));
		await expect(
			createRepositoryHost('codeberg.org', 'fixture-secret').authenticate(),
		).rejects.toThrow('HTTP 401');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test('reports a success response that is not JSON by operation and status alone', async () => {
		installFetch(echoingNonJson);
		const host = createRepositoryHost('codeberg.org', ECHOED);
		for (const [run, operation] of [
			[() => host.authenticate(), 'reading the authenticated account'],
			[() => host.listStars(), 'listing starred repositories'],
			[() => host.resolve('example', 'repo', undefined), 'resolving example/repo'],
			[() => host.resolve('example', 'repo', 3), 'resolving repository 3'],
		] as const) {
			const failure = await run().then(
				() => undefined,
				(err: unknown) => err,
			);
			expect(failure).toBeInstanceOf(Error);
			const error = failure as { status?: number } & Error;
			expect(error.message).toBe(
				`Codeberg API returned a response that is not valid JSON (HTTP 200) while ${operation}.`,
			);
			expect(error.status).toBe(200);
			expect(error.cause).toBeUndefined();
			expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(ECHOED);
		}
	});

	test('keeps an echoed credential out of init reports and both CLI output modes', async () => {
		for (const [handler, expected] of [
			[echoingNonJson, 'not valid JSON (HTTP 200)'],
			// The control: a failure status already gets the fixed HTTP diagnostic.
			[() => Promise.resolve(new Response(`token ${ECHOED}`, { status: 401 })), 'HTTP 401'],
		] as const) {
			installFetch(handler);
			const targetPath = mkdtempSync(path.join(tmpdir(), 'starsync-codeberg-json-'));
			temporaryRoots.push(targetPath);
			const report = await initArchive({ host: 'codeberg.org', targetPath, token: ECHOED });
			expect(report.exitCode).toBe(1);
			expect(report.findings.map((finding) => finding.code)).toEqual([
				'host-authentication-failed',
			]);
			expect(JSON.stringify(report)).not.toContain(ECHOED);
			for (const json of [true, false]) {
				const output = captureStreams(() => createCommandReporter(json).emit(report));
				expect(output).toContain(expected);
				expect(output).not.toContain(ECHOED);
			}
		}
	});

	test('validates host config, CLI values and cross-host origins', () => {
		const owner = { id: 7, login: 'example' };
		expect(parseArchiveConfig({ archiveFormat: 2, owner })).toEqual({
			archiveFormat: 2,
			owner,
		});
		expect(parseArchiveConfig({ archiveFormat: 2, host: 'codeberg.org', owner }).host).toBe(
			'codeberg.org',
		);
		expect(() => parseArchiveConfig({ archiveFormat: 2, host: 'evil.test', owner })).toThrow();
		expect(parseHostArgs(['--host', 'codeberg.org', 'archive']).host).toBe('codeberg.org');
		expect(parseHostArgs(['--host=codeberg.org']).host).toBe('codeberg.org');
		for (const args of [
			['--host'],
			['--host='],
			['--host=codeberg.org', '--host=github.com'],
		]) {
			expect(() => parseHostArgs(args)).toThrow();
		}
		expect(
			parseGitHubRepositorySlug('https://github.com/example/repo.git', 'codeberg.org'),
		).toBeNull();
		expect(
			parseGitHubRepositorySlug('git@codeberg.org:example/repo.git', 'codeberg.org'),
		).toEqual({ owner: 'example', repository: 'repo' });
	});
});
