import { describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CommandReport } from '../src/lib/reporting.ts';

const projectRoot = path.resolve(import.meta.dir, '..');

const run = (command: string[], cwd = projectRoot): string => {
	const result = Bun.spawnSync({ cmd: command, cwd, stderr: 'pipe', stdout: 'pipe' });
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.toString() || result.stdout.toString());
	}
	return result.stdout.toString().trim();
};

const createRepository = (
	root: string,
	name: string,
	origin: string,
	identity?: { id: number; slug: string },
): string => {
	const checkout = path.join(root, name);
	mkdirSync(checkout);
	run(['git', 'init', '--quiet'], checkout);
	run(['git', 'config', 'user.name', 'StarSync Test'], checkout);
	run(['git', 'config', 'user.email', 'starsync@example.invalid'], checkout);
	writeFileSync(path.join(checkout, 'README.md'), '# fixture\n');
	run(['git', 'add', 'README.md'], checkout);
	run(['git', 'commit', '--quiet', '-m', 'fixture'], checkout);
	run(['git', 'remote', 'add', 'origin', origin], checkout);
	if (identity) {
		run(['git', 'config', 'starsync.repository-id', String(identity.id)], checkout);
		run(['git', 'config', 'starsync.repository-slug', identity.slug], checkout);
	}
	return checkout;
};

const writeArchiveConfig = (root: string, owner: unknown): void => {
	mkdirSync(path.join(root, '.starsync'));
	writeFileSync(
		path.join(root, '.starsync', 'config.json'),
		JSON.stringify({ archiveFormat: 2, owner }),
	);
};

const verify = (
	target: string,
	options: { force?: boolean } = {},
): { report: CommandReport; status: number; stderr: string } => {
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			'src/cli.ts',
			'verify',
			'--json',
			...(options.force ? ['--force'] : []),
			target,
		],
		cwd: projectRoot,
		env: { ...process.env, GITHUB_TOKEN: '' },
		stderr: 'pipe',
		stdout: 'pipe',
	});
	return {
		report: JSON.parse(result.stdout.toString()) as CommandReport,
		status: result.exitCode,
		stderr: result.stderr.toString(),
	};
};

describe('archive verification process boundary', () => {
	test('verifies a managed archive without a token or filesystem changes', () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-verify-managed-'));
		try {
			const checkout = createRepository(
				target,
				'repo--owner',
				'https://github.com/owner/repo.git',
				{ id: 123, slug: 'owner/repo' },
			);
			writeArchiveConfig(target, { id: 7, login: 'archive-owner' });
			const namesBefore = readdirSync(target).sort();
			const configBefore = readFileSync(path.join(checkout, '.git', 'config'), 'utf-8');
			const mtimeBefore = statSync(checkout).mtimeMs;

			const result = verify(target);

			expect(result.status).toBe(0);
			expect(result.report.exitCode).toBe(0);
			expect(result.report.checkouts[0]?.outcome).toBe('current');
			expect(
				result.report.findings.some((finding) => finding.code === 'archive-owner-bound'),
			).toBe(true);
			expect(readdirSync(target).sort()).toEqual(namesBefore);
			expect(readFileSync(path.join(checkout, '.git', 'config'), 'utf-8')).toBe(configBefore);
			expect(statSync(checkout).mtimeMs).toBe(mtimeBefore);
			expect(run(['git', 'status', '--porcelain'], checkout)).toBe('');
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('reports owner-only and repository-only canonical casing as pending renames', () => {
		for (const identity of [
			{ canonicalName: 'repo--Owner', slug: 'Owner/repo' },
			{ canonicalName: 'Repo--owner', slug: 'owner/Repo' },
		]) {
			const target = mkdtempSync(path.join(tmpdir(), 'starsync-verify-casing-'));
			try {
				createRepository(target, 'repo--owner', 'https://github.com/owner/repo.git', {
					id: 123,
					slug: identity.slug,
				});
				writeArchiveConfig(target, { id: 7, login: 'archive-owner' });

				const result = verify(target);
				const checkout = result.report.checkouts[0];

				expect(result.status).toBe(0);
				expect(checkout?.pendingRename).toBe(true);
				expect(checkout?.findings).toContainEqual(
					expect.objectContaining({
						code: 'pending-rename',
						message: `Checkout folder should be named ${identity.canonicalName}.`,
					}),
				);
			} finally {
				rmSync(target, { force: true, recursive: true });
			}
		}
	});

	test('requires a token before forced verification can modify an archive', () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-verify-force-token-'));
		try {
			const checkout = createRepository(
				target,
				'repo--owner',
				'https://github.com/owner/repo.git',
				{ id: 123, slug: 'owner/repo' },
			);
			writeArchiveConfig(target, { id: 7, login: 'archive-owner' });
			const configBefore = readFileSync(path.join(checkout, '.git', 'config'));

			const result = verify(target, { force: true });

			expect(result.status).toBe(1);
			expect(result.report.findings[0]?.code).toBe('missing-token');
			expect(readFileSync(path.join(checkout, '.git', 'config'))).toEqual(configBefore);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('rejects a current archive checkout that lacks stable identity metadata', () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-verify-missing-identity-'));
		try {
			createRepository(target, 'repo', 'https://github.com/owner/repo.git');
			writeArchiveConfig(target, { id: 7, login: 'archive-owner' });

			const result = verify(target);
			const checkout = result.report.checkouts[0];

			expect(result.status).toBe(1);
			expect(checkout?.pendingRename).toBe(true);
			expect(
				checkout?.findings.some(
					(finding) =>
						finding.code === 'missing-identity-metadata' &&
						finding.severity === 'error',
				),
			).toBe(true);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('reports duplicate identities, blocked state, and credential-bearing origins as errors', () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-verify-errors-'));
		try {
			const first = createRepository(
				target,
				'first--owner',
				'https://github.com/owner/first.git',
				{ id: 42, slug: 'owner/first' },
			);
			createRepository(
				target,
				'second--owner',
				'https://user:secret@github.com/owner/second.git',
				{ id: 42, slug: 'owner/second' },
			);
			createRepository(target, 'third--owner', 'https://github.com/owner/third/issues', {
				id: 43,
				slug: 'owner/third',
			});
			writeFileSync(path.join(first, 'dirty.txt'), 'local change\n');
			writeArchiveConfig(target, { id: 7, login: 'archive-owner' });

			const result = verify(target);
			const findingCodes = result.report.checkouts.flatMap((checkout) =>
				checkout.findings.map((finding) => finding.code),
			);

			expect(result.status).toBe(1);
			expect(findingCodes).toContain('duplicate-identity');
			expect(findingCodes).toContain('checkout-blocked');
			expect(findingCodes).toContain('credential-bearing-origin');
			expect(findingCodes).toContain('invalid-origin');
			expect(result.stderr).not.toContain('user:secret');
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('rejects corrupt Git objects in a current archive', () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-verify-corrupt-'));
		try {
			const checkout = createRepository(
				target,
				'repo--owner',
				'https://github.com/owner/repo.git',
				{ id: 123, slug: 'owner/repo' },
			);
			writeArchiveConfig(target, { id: 7, login: 'archive-owner' });
			const objectFile = run(['git', 'rev-parse', '--git-path', 'objects'], checkout);
			const objectDirectories = readdirSync(path.join(checkout, objectFile)).filter(
				(name) => name.length === 2 && name !== 'info' && name !== 'pack',
			);
			const objectDirectory = path.join(checkout, objectFile, objectDirectories[0]!);
			const objectName = readdirSync(objectDirectory)[0]!;
			rmSync(path.join(objectDirectory, objectName), { force: true });

			const result = verify(target);

			expect(result.status).toBe(1);
			expect(
				result.report.checkouts[0]?.findings.some(
					(finding) => finding.code === 'git-integrity-failed',
				),
			).toBe(true);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('returns a schema-compatible partial result after interruption', () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-verify-interrupted-'));
		try {
			createRepository(target, 'repo', 'https://github.com/owner/repo.git');
			writeArchiveConfig(target, { id: 7, login: 'archive-owner' });
			const moduleUrl = pathToFileURL(
				path.join(projectRoot, 'src', 'lib', 'archive-verification.ts'),
			).href;
			const script =
				`import { verifyArchive } from ${JSON.stringify(moduleUrl)};` +
				`const result = await verifyArchive(${JSON.stringify(target)}, ` +
				`{ isInterruptionRequested: () => true });` +
				`console.log(JSON.stringify(result));`;
			const result = Bun.spawnSync({
				cmd: [process.execPath, '-e', script],
				cwd: projectRoot,
				stderr: 'pipe',
				stdout: 'pipe',
			});
			const parsed = JSON.parse(result.stdout.toString()) as {
				checkouts: { findings: { code: string }[] }[];
				exitCode: number;
				interrupted: boolean;
			};

			expect(result.exitCode).toBe(0);
			expect(parsed.exitCode).toBe(130);
			expect(parsed.interrupted).toBe(true);
			expect(parsed.checkouts[0]?.findings[0]?.code).toBe('interrupted-before-verification');
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});
});
