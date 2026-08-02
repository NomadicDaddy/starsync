import { describe, expect, test } from 'bun:test';
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { RepoRecord } from '../src/lib/refresh.ts';
import type { RepositoryResolver } from '../src/lib/repository-resolution.ts';

import { normalizeArchiveDates } from '../src/index.ts';
import { applyArchiveRenames } from '../src/lib/archive-rename-apply.ts';
import { verifyArchive } from '../src/lib/archive-verification.ts';
import { processRepository, runSyncPool } from '../src/lib/refresh.ts';

const run = (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): string => {
	const result = Bun.spawnSync({
		cmd: [command, ...args],
		cwd,
		env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
		stderr: 'pipe',
		stdin: 'ignore',
		stdout: 'pipe',
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`${command} ${args.join(' ')} failed: ${result.stderr.toString() || result.stdout.toString()}`
		);
	}
	return result.stdout.toString().trim();
};

const runGit = (args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): string =>
	run('git', args, cwd, env);

interface RepositoryFixture {
	canonicalName: string;
	cloneUrl: string;
	id: number;
	origin: string;
	repository: string;
	seed: string;
}

const createRepositoryFixture = (
	root: string,
	archive: string,
	repository: string,
	checkoutName: string,
	id: number
): RepositoryFixture => {
	const seed = path.join(root, `${repository}-seed`);
	const origin = path.join(root, `${repository}.git`);
	const checkout = path.join(archive, checkoutName);
	const cloneUrl = `https://github.com/owner/${repository}.git`;
	const commitEnvironment = {
		GIT_AUTHOR_DATE: '2026-07-20T12:00:00Z',
		GIT_COMMITTER_DATE: '2026-07-20T12:00:00Z',
	};

	mkdirSync(seed);
	runGit(['init', '--initial-branch=main'], seed);
	runGit(['config', 'user.email', 'starsync@example.test'], seed);
	runGit(['config', 'user.name', 'StarSync Test'], seed);
	writeFileSync(path.join(seed, 'README.md'), `# ${repository}\n`);
	runGit(['add', 'README.md'], seed);
	runGit(['commit', '-m', 'initial'], seed, commitEnvironment);
	runGit(['clone', '--bare', seed, origin], root);
	runGit(['remote', 'add', 'origin', origin], seed);

	runGit(['clone', origin, checkout], archive);
	runGit(['remote', 'set-url', 'origin', cloneUrl], checkout);
	runGit(
		['config', '--local', `url.${pathToFileURL(origin).href}.insteadOf`, cloneUrl],
		checkout
	);
	runGit(['config', '--local', 'starsync.repository-id', String(id)], checkout);
	runGit(['config', '--local', 'starsync.repository-slug', `owner/${repository}`], checkout);

	return {
		canonicalName: `${repository}--owner`,
		cloneUrl,
		id,
		origin,
		repository,
		seed,
	};
};

const addRemoteCommit = (fixture: RepositoryFixture): void => {
	const commitEnvironment = {
		GIT_AUTHOR_DATE: '2026-07-21T13:30:00Z',
		GIT_COMMITTER_DATE: '2026-07-21T13:30:00Z',
	};
	writeFileSync(path.join(fixture.seed, 'RELEASE.md'), 'representative refresh\n');
	runGit(['add', 'RELEASE.md'], fixture.seed);
	runGit(['commit', '-m', 'representative refresh'], fixture.seed, commitEnvironment);
	runGit(['push', 'origin', 'HEAD'], fixture.seed);
};

describe('cross-platform release validation', () => {
	test('keeps local deployment guidance compatible with format 2', async () => {
		const guide = Bun.file(path.resolve('.aidd/deployment.md'));
		if (!(await guide.exists())) return;
		const deployment = await guide.text();
		expect(deployment).toContain('bun pm pkg get version');
		expect(deployment).toContain('only published tag is `v1.4.1`');
		expect(deployment).toContain('no `v2.0.0` tag');
		expect(deployment).toContain('must not be used with a format-2 Managed Archive');
		expect(deployment).toContain('verified 2.x commit or tag');
	});

	test('bounds and supersedes the full three-platform release matrix', () => {
		const workflow = readFileSync(
			path.resolve('.github/workflows/release-validation.yml'),
			'utf-8'
		);

		expect(workflow).toMatch(
			/^on:\r?\n {4}pull_request:\r?\n {4}push:\r?\n {8}branches:\r?\n {12}- main\r?\n {4}workflow_dispatch:$/m
		);
		expect(workflow).toMatch(
			/^concurrency:\r?\n {4}group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\r?\n {4}cancel-in-progress: true$/m
		);
		expect(workflow).toMatch(
			/^ {4}cross-platform:\r?\n {8}name: Bun 1\.3\.14 \/ \$\{\{ matrix\.os \}\}\r?\n {8}runs-on: \$\{\{ matrix\.os \}\}\r?\n {8}timeout-minutes: 20$/m
		);
		expect(workflow).toMatch(
			/^ {12}matrix:\r?\n {16}os:\r?\n {20}- macos-latest\r?\n {20}- ubuntu-latest\r?\n {20}- windows-latest$/m
		);
	});

	test('pins every third-party action to a full commit with a release-tag comment', () => {
		const workflow = readFileSync(
			path.resolve('.github/workflows/release-validation.yml'),
			'utf-8'
		);
		const thirdPartyUsesLines = workflow
			.split(/\r?\n/)
			.filter((line) => /^\s*uses:\s+(?!\.\/)\S+/.test(line));

		expect(thirdPartyUsesLines.length).toBeGreaterThan(0);
		for (const line of thirdPartyUsesLines) {
			expect(line).toMatch(
				/^\s*uses:\s+[a-z0-9_.-]+\/[a-z0-9_.-]+@[0-9a-f]{40}\s+#\s+v\d+(?:\.\d+){0,2}\s*$/i
			);
		}
	});

	test('runs a copied format-2 archive through rename, verification, refresh, and dates offline', async () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-release-copy-'));
		const sourceArchive = path.join(root, 'source-archive');
		const copiedArchive = path.join(root, 'representative-copy');
		mkdirSync(sourceArchive);
		mkdirSync(path.join(sourceArchive, '.starsync'));
		writeFileSync(
			path.join(sourceArchive, '.starsync', 'config.json'),
			JSON.stringify({ archiveFormat: 2, owner: { id: 7, login: 'archive-owner' } })
		);
		const fixtures = [
			createRepositoryFixture(root, sourceArchive, 'alpha', 'alpha--previous-owner', 101),
			createRepositoryFixture(root, sourceArchive, 'beta', 'beta--owner', 202),
		];
		cpSync(sourceArchive, copiedArchive, { recursive: true });

		const resolveRepository: RepositoryResolver = async (owner, repository) => {
			const fixture = fixtures.find(
				(candidate) => owner === 'owner' && candidate.repository === repository
			);
			if (fixture === undefined)
				throw new Error(`Unexpected repository: ${owner}/${repository}`);
			return {
				id: fixture.id,
				name: fixture.repository,
				owner: 'owner',
				slug: `owner/${fixture.repository}`,
			};
		};

		try {
			const rename = await applyArchiveRenames(copiedArchive, resolveRepository);
			expect(rename).toMatchObject({ exitCode: 0 });
			expect(rename.checkouts.map((checkout) => checkout.name).sort()).toEqual([
				'alpha--owner',
				'beta--owner',
			]);

			const verification = await verifyArchive(copiedArchive);
			expect(verification.exitCode).toBe(0);
			expect(verification.checkouts).toHaveLength(2);

			fixtures.forEach(addRemoteCommit);
			const repositories: RepoRecord[] = fixtures.map((fixture) => ({
				clone_url: fixture.cloneUrl,
				defaultBranch: 'main',
				folderName: fixture.canonicalName,
				id: fixture.id,
				name: fixture.repository,
				slug: `owner/${fixture.repository}`,
			}));
			const synchronization = await runSyncPool(
				repositories,
				(repository, isInterruptionRequested) =>
					processRepository(repository, copiedArchive, isInterruptionRequested, {
						archiveOwnerId: 7,
					}),
				{ concurrency: 2, totalCount: repositories.length }
			);
			expect(synchronization.interrupted).toBe(false);
			expect(synchronization.results.map((result) => result.outcome)).toEqual([
				'updated',
				'updated',
			]);

			const dates = await normalizeArchiveDates({ targetPath: copiedArchive });
			expect(dates.exitCode).toBe(0);
			for (const fixture of fixtures) {
				const checkout = path.join(copiedArchive, fixture.canonicalName);
				expect(runGit(['log', '-1', '--pretty=%s'], checkout)).toBe(
					'representative refresh'
				);
				expect(
					runGit(['config', '--local', '--get', 'starsync.repository-id'], checkout)
				).toBe(String(fixture.id));
				expect(Math.trunc(statSync(checkout).mtimeMs / 1000)).toBe(
					Math.trunc(
						new Date(runGit(['log', '-1', '--format=%cI'], checkout)).getTime() / 1000
					)
				);
			}
			expect(
				JSON.parse(
					readFileSync(path.join(copiedArchive, '.starsync', 'config.json'), 'utf-8')
				)
			).toEqual({
				archiveFormat: 2,
				owner: { id: 7, login: 'archive-owner' },
			});
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	}, 20_000);

	test('keeps live smoke disabled unless the caller explicitly opts in', () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-live-smoke-disabled-'));
		try {
			const result = Bun.spawnSync({
				cmd: [process.execPath, path.resolve('scripts/live-smoke.ts'), target],
				env: {
					...process.env,
					GITHUB_TOKEN: '',
					STARSYNC_LIVE_SMOKE: '0',
					TARGET_PATH: '',
				},
				stderr: 'pipe',
				stdout: 'pipe',
			});
			expect(result.exitCode).toBe(2);
			expect(result.stderr.toString()).toContain('Live smoke is disabled.');
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('refuses a configured archive reached through an alternate path', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-live-smoke-configured-'));
		const target = path.join(root, 'target');
		const configuredAlias = path.join(root, 'configured-alias');
		mkdirSync(target);
		symlinkSync(target, configuredAlias, process.platform === 'win32' ? 'junction' : 'dir');
		try {
			const result = Bun.spawnSync({
				cmd: [process.execPath, path.resolve('scripts/live-smoke.ts'), target],
				env: {
					...process.env,
					GITHUB_TOKEN: 'test-token',
					STARSYNC_LIVE_SMOKE: '1',
					TARGET_PATH: configuredAlias,
				},
				stderr: 'pipe',
				stdout: 'pipe',
			});
			expect(result.exitCode).toBe(2);
			expect(result.stderr.toString()).toContain(
				'Live smoke refuses to run against the configured archive.'
			);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});
});
