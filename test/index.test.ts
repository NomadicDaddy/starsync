import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { execFile as actualExecFile, execFileSync as actualExecFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ParsedArgs } from '../src/lib/cli-utils.ts';
import type { CommandReport } from '../src/lib/reporting.ts';

import {
	initArchive,
	normalizeArchiveDates,
	renameArchive,
	syncArchive,
	verifyArchive,
} from '../src/index.ts';
import { inspectArchive } from '../src/lib/archive-inspection.ts';
import { parseArgs, resolveTargetPath, stripQuotes } from '../src/lib/cli-utils.ts';
import { SYNC_HELP_TEXT } from '../src/lib/help-text.ts';
import { createCommandReport, createCommandReporter, createFinding } from '../src/lib/reporting.ts';
import {
	hasEmbeddedCredentials,
	isGitAuthError,
	isGitHubDotComUrl,
	sanitizeMessage,
	sanitizeUrl,
	extractHost,
} from '../src/lib/secret-safety.ts';
import { dispatchSync } from '../src/lib/subcommands.ts';

const mockExecFileSync = mock(
	(_cmd: string, _args: string[], _options?: unknown): string | undefined => undefined
);

const mockExecFile = mock(
	(
		_cmd: string,
		_args: string[],
		_options: unknown,
		callback: (err: Error | null, stdout: string, stderr: string) => void
	): void => {
		// Simulate success by default
		callback(null, '', '');
	}
);

const callActualExecFile = actualExecFile as unknown as (
	cmd: string,
	args: string[],
	options: unknown,
	callback: (err: Error | null, stdout: string, stderr: string) => void
) => void;
const callActualExecFileSync = actualExecFileSync as unknown as (
	cmd: string,
	args: string[],
	options?: unknown
) => string;

mock.module('node:child_process', () => ({
	execFile: mockExecFile,
	execFileSync: mockExecFileSync,
}));

interface MockRepoResponse {
	clone_url: string;
	default_branch: string;
	full_name: string;
	id: number;
	name: string;
	owner: { login: string };
}

const mockStarredRepository = (
	name: string,
	id: number,
	owner = 'example',
	defaultBranch = 'main'
): MockRepoResponse => ({
	clone_url: `https://github.com/${owner}/${name}.git`,
	default_branch: defaultBranch,
	full_name: `${owner}/${name}`,
	id,
	name,
	owner: { login: owner },
});

const mockPaginate = mock((): Promise<MockRepoResponse[]> => Promise.resolve([]));
const mockGetRepository = mock(
	(_params: {
		owner: string;
		repo: string;
	}): Promise<{
		data: { full_name: string; id: number; name: string; owner: { login: string } };
	}> =>
		Promise.resolve({
			data: {
				full_name: 'example/test-repo',
				id: 1,
				name: 'test-repo',
				owner: { login: 'example' },
			},
		})
);
const mockGetAuthenticated = mock(() =>
	Promise.resolve({
		data: {
			id: 7,
			login: 'archive-owner',
		},
	})
);

mock.module('@octokit/rest', () => ({
	Octokit: class MockOctokit {
		rest = {
			activity: {
				listReposStarredByAuthenticatedUser: {},
			},
			repos: {
				get: mockGetRepository,
			},
			users: {
				getAuthenticated: mockGetAuthenticated,
			},
		};
		paginate = mockPaginate;
	},
}));

const captureConsole = async <T>(
	operation: () => Promise<T> | T
): Promise<{ result: T; stderr: string[]; stdout: string[] }> => {
	const stderr: string[] = [];
	const stdout: string[] = [];
	const originalError = console.error;
	const originalLog = console.log;
	const originalWarn = console.warn;
	console.error = (...args: unknown[]) => stderr.push(args.map(String).join(' '));
	console.log = (...args: unknown[]) => stdout.push(args.map(String).join(' '));
	console.warn = (...args: unknown[]) => stderr.push(args.map(String).join(' '));
	try {
		return { result: await operation(), stderr, stdout };
	} finally {
		console.error = originalError;
		console.log = originalLog;
		console.warn = originalWarn;
	}
};

const parseReport = (stdout: string[]): CommandReport =>
	JSON.parse(stdout.at(0) ?? '') as CommandReport;

const createCheckout = (root: string, name: string): string => {
	const checkoutPath = path.join(root, name);
	mkdirSync(path.join(checkoutPath, '.git'), { recursive: true });
	return checkoutPath;
};

const runRealCommand = (
	command: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv = {}
): string => {
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

const runRealGit = (args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): string =>
	runRealCommand('git', args, cwd, env);

interface RealRefreshFixture {
	archive: string;
	checkout: string;
	cloneUrl: string;
	origin: string;
	seed: string;
}

const createRealRefreshFixture = (root: string): RealRefreshFixture => {
	const archive = path.join(root, 'archive');
	const checkout = path.join(archive, 'repository--example');
	const cloneUrl = 'https://github.com/example/repository.git';
	const origin = path.join(root, 'repository.git');
	const seed = path.join(root, 'seed');

	mkdirSync(archive);
	mkdirSync(seed);
	runRealGit(['init', '--initial-branch=main'], seed);
	runRealGit(['config', 'user.email', 'starsync@example.test'], seed);
	runRealGit(['config', 'user.name', 'StarSync Test'], seed);
	writeFileSync(path.join(seed, 'README.md'), '# repository\n');
	runRealGit(['add', 'README.md'], seed);
	runRealGit(['commit', '-m', 'initial'], seed);
	runRealGit(['clone', '--bare', seed, origin], root);
	runRealGit(['remote', 'add', 'origin', origin], seed);
	runRealGit(['clone', origin, checkout], archive);
	runRealGit(['config', 'user.email', 'starsync@example.test'], checkout);
	runRealGit(['config', 'user.name', 'StarSync Test'], checkout);
	runRealGit(['remote', 'set-url', 'origin', cloneUrl], checkout);
	runRealGit(
		['config', '--local', `url.${pathToFileURL(origin).href}.insteadOf`, cloneUrl],
		checkout
	);
	runRealGit(['config', '--local', 'starsync.repository-id', '321'], checkout);
	runRealGit(['config', '--local', 'starsync.repository-slug', 'example/repository'], checkout);

	return { archive, checkout, cloneUrl, origin, seed };
};

const addRealCommit = (
	repositoryPath: string,
	fileName: string,
	content: string,
	message: string
): void => {
	writeFileSync(path.join(repositoryPath, fileName), content);
	runRealGit(['add', fileName], repositoryPath);
	runRealGit(['commit', '-m', message], repositoryPath);
};

const pushRealBranch = (fixture: RealRefreshFixture, branch: string): void => {
	runRealGit(['push', 'origin', branch], fixture.seed);
};

const runRealRefresh = (
	fixture: RealRefreshFixture,
	defaultBranch: string,
	labels: { cloneUrl: string; slug: string } = {
		cloneUrl: fixture.cloneUrl,
		slug: 'example/repository',
	}
): { message?: string; outcome: string } => {
	const repository = {
		clone_url: labels.cloneUrl,
		defaultBranch,
		folderName: path.basename(fixture.checkout),
		id: 321,
		name: 'repository',
		slug: labels.slug,
	};
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			path.resolve('test/helpers/run-staged-checkout.ts'),
			fixture.archive,
		],
		env: {
			...process.env,
			TEST_ARCHIVE_OWNER_ID: '7',
			TEST_REPOSITORY: JSON.stringify(repository),
		},
		stderr: 'pipe',
		stdin: 'ignore',
		stdout: 'pipe',
	});
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.toString() || result.stdout.toString());
	}
	return JSON.parse(result.stdout.toString()) as { message?: string; outcome: string };
};

const writeManagedArchiveConfig = (
	root: string,
	owner: { id: number; login: string } = { id: 7, login: 'archive-owner' }
): void => {
	mkdirSync(path.join(root, '.starsync'), { recursive: true });
	writeFileSync(
		path.join(root, '.starsync', 'config.json'),
		JSON.stringify({ archiveFormat: 2, owner })
	);
};

const mockManagedCheckoutIdentity = (
	folderName: string,
	repositoryId: number,
	repositorySlug: string,
	status = '',
	archiveDate = '2026-07-16T10:00:00Z'
): void => {
	let currentOrigin = `https://github.com/${repositorySlug}.git`;
	let currentRepositoryId = String(repositoryId);
	let currentRepositorySlug = repositorySlug;
	mockExecFile.mockImplementation((_cmd, args, options, callback) => {
		const cwd = (options as { cwd?: string } | undefined)?.cwd ?? '';
		if (path.basename(cwd) === folderName && args[0] === 'remote' && args[1] === 'set-url') {
			currentOrigin = args.at(-1) ?? currentOrigin;
			callback(null, '', '');
			return;
		}
		if (path.basename(cwd) === folderName && args[0] === 'config' && !args.includes('--get')) {
			if (args.includes('starsync.repository-id')) {
				currentRepositoryId = args.at(-1) ?? currentRepositoryId;
			}
			if (args.includes('starsync.repository-slug')) {
				currentRepositorySlug = args.at(-1) ?? currentRepositorySlug;
			}
			callback(null, '', '');
			return;
		}
		if (path.basename(cwd) === folderName && args.includes('--get')) {
			if (args.includes('remote.origin.url')) {
				callback(null, `${currentOrigin}\n`, '');
				return;
			}
			callback(
				null,
				args.includes('starsync.repository-id')
					? `${currentRepositoryId}\n`
					: `${currentRepositorySlug}\n`,
				''
			);
			return;
		}
		if (args.includes('log')) {
			callback(null, `${archiveDate}\n`, '');
			return;
		}
		callback(null, args.includes('status') ? status : '', '');
	});
};

interface SuccessfulCloneHooks {
	afterClone?: (cloneUrl: string, stagingPath: string) => void;
	cloneFailure?: (cloneUrl: string, stagingPath: string) => Error | null;
	onArchiveDateRead?: (
		cwd: string,
		callback: (err: Error | null, stdout: string, stderr: string) => void
	) => boolean;
}

const mockSuccessfulCloneAndDateOperations = (
	failingRepository?: string,
	hooks: SuccessfulCloneHooks = {}
): void => {
	const origins = new Map<string, string>();
	const repositoryIds = new Map<string, string>();
	const repositorySlugs = new Map<string, string>();
	mockExecFile.mockImplementation((_cmd, args, options, callback) => {
		const cwd = (options as { cwd?: string } | undefined)?.cwd;
		if (
			failingRepository !== undefined &&
			args.some((arg) => arg.includes(failingRepository))
		) {
			callback(new Error('fatal: repository not found'), '', '');
			return;
		}
		if (args[0] === 'clone') {
			const folderName = args.at(-1);
			const cloneUrl = args[1];
			if (cwd !== undefined && folderName !== undefined && cloneUrl !== undefined) {
				const stagingPath = path.join(cwd, folderName);
				mkdirSync(path.join(stagingPath, '.git'), { recursive: true });
				const cloneFailure = hooks.cloneFailure?.(cloneUrl, stagingPath);
				if (cloneFailure !== null && cloneFailure !== undefined) {
					callback(cloneFailure, '', '');
					return;
				}
				origins.set(stagingPath, cloneUrl);
				hooks.afterClone?.(cloneUrl, stagingPath);
			}
		}
		if (cwd !== undefined && args[0] === 'config') {
			if (args.includes('--get')) {
				if (args.includes('remote.origin.url')) {
					callback(null, `${origins.get(cwd) ?? ''}\n`, '');
					return;
				}
				if (args.includes('starsync.repository-id')) {
					callback(null, `${repositoryIds.get(cwd) ?? ''}\n`, '');
					return;
				}
				if (args.includes('starsync.repository-slug')) {
					callback(null, `${repositorySlugs.get(cwd) ?? ''}\n`, '');
					return;
				}
			}
			if (args.includes('starsync.repository-id')) {
				repositoryIds.set(cwd, args.at(-1) ?? '');
			}
			if (args.includes('starsync.repository-slug')) {
				repositorySlugs.set(cwd, args.at(-1) ?? '');
			}
		}
		if (cwd !== undefined && args.includes('log') && hooks.onArchiveDateRead?.(cwd, callback)) {
			return;
		}
		callback(null, args.includes('log') ? '2026-07-16T10:00:00Z\n' : '', '');
	});
};

afterEach(() => {
	mockExecFile.mockClear();
	mockExecFileSync.mockReset();
	mockGetAuthenticated.mockClear();
	mockGetAuthenticated.mockImplementation(() =>
		Promise.resolve({
			data: {
				id: 7,
				login: 'archive-owner',
			},
		})
	);
	mockGetRepository.mockReset();
	mockPaginate.mockReset();
});

afterAll(() => {
	mockExecFile.mockImplementation(callActualExecFile);
	mockExecFileSync.mockImplementation(callActualExecFileSync);
});

describe('argument parsing', () => {
	test('accepts help flags and an optional target path', () => {
		expect(parseArgs([])).toEqual({
			concurrency: 4,
			dryRun: false,
			help: false,
			json: false,
			targetPath: null,
		});
		expect(parseArgs(['--help'])).toEqual({
			concurrency: 4,
			dryRun: false,
			help: true,
			json: false,
			targetPath: null,
		});
		expect(parseArgs(['-h'])).toEqual({
			concurrency: 4,
			dryRun: false,
			help: true,
			json: false,
			targetPath: null,
		});
		expect(parseArgs(['repos'])).toEqual({
			concurrency: 4,
			dryRun: false,
			help: false,
			json: false,
			targetPath: 'repos',
		});
	});

	test('rejects unknown flags and repeated target paths', () => {
		expect(() => parseArgs(['--bad'])).toThrow('Unknown argument: --bad');
		expect(() => parseArgs(['one', 'two'])).toThrow('Unexpected positional argument: two');
	});
});

describe('target path resolution', () => {
	test('positional target overrides environment target', () => {
		expect(resolveTargetPath('repos', '/ignored')).toBe(path.resolve('repos'));
	});

	test('uses quoted environment target when no positional target is provided', () => {
		expect(resolveTargetPath(null, '"repos from env"')).toBe(path.resolve('repos from env'));
	});

	test('rejects a missing explicit target', () => {
		expect(() => resolveTargetPath(null, '')).toThrow(
			'A target path or TARGET_PATH is required.'
		);
	});

	test('strips surrounding quotes and whitespace', () => {
		expect(stripQuotes(' "C:/repos" ')).toBe('C:/repos');
		expect(stripQuotes("'C:/repos'")).toBe('C:/repos');
	});
});

describe('programmatic archive API', () => {
	test('carries the GitHub default branch into existing checkout refresh', async () => {
		mockPaginate.mockResolvedValue([mockStarredRepository('repo-a', 101, 'example', 'trunk')]);
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-api-default-'));
		try {
			writeManagedArchiveConfig(target);
			createCheckout(target, 'repo-a--example');
			mockManagedCheckoutIdentity('repo-a--example', 101, 'example/repo-a');

			const report = await syncArchive({
				concurrency: 1,
				targetPath: target,
				token: 'test-token',
			});

			expect(report.exitCode).toBe(0);
			expect(mockExecFile).toHaveBeenCalledWith(
				'git',
				['rev-parse', '--verify', 'refs/remotes/origin/trunk^{commit}'],
				expect.objectContaining({ cwd: path.join(target, 'repo-a--example') }),
				expect.any(Function)
			);
			expect(mockExecFile).toHaveBeenCalledWith(
				'git',
				['switch', '--create', 'trunk', '--track', 'refs/remotes/origin/trunk'],
				expect.objectContaining({ cwd: path.join(target, 'repo-a--example') }),
				expect.any(Function)
			);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('syncArchive uses only explicit options and returns the JSON report model', async () => {
		mockPaginate.mockResolvedValue([mockStarredRepository('repo-a', 101)]);
		const savedArgv = process.argv;
		const savedToken = process.env.GITHUB_TOKEN;
		process.argv = ['bun', 'unexpected-cli-argument'];
		delete process.env.GITHUB_TOKEN;
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-api-sync-'));
		writeManagedArchiveConfig(target);
		const progress: string[] = [];
		try {
			const captured = await captureConsole(() =>
				syncArchive({
					concurrency: 1,
					dryRun: true,
					onProgress: (message) => progress.push(message),
					targetPath: target,
					token: 'explicit-test-token',
				})
			);

			expect(captured.stdout).toEqual([]);
			expect(captured.stderr).toEqual([]);
			expect(captured.result.schemaVersion).toBe(2);
			expect(captured.result.command).toBe('sync');
			expect(captured.result.exitCode).toBe(0);
			expect(captured.result.checkouts[0]).toEqual(
				expect.objectContaining({ name: 'repo-a--example', plannedOutcome: 'added' })
			);
			expect(progress.some((message) => message.includes('Syncing 1/1'))).toBe(true);
		} finally {
			process.argv = savedArgv;
			if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = savedToken;
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('all archive operations return reports without writing process output', async () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-api-operations-'));
		try {
			const captured = await captureConsole(async () => [
				await initArchive({ targetPath: target, token: 'test-token' }),
				await renameArchive({ apply: true, targetPath: target, token: 'test-token' }),
				await normalizeArchiveDates({ dryRun: true, targetPath: target }),
				await verifyArchive({ targetPath: path.join(target, 'missing') }),
			]);

			expect(captured.stdout).toEqual([]);
			expect(captured.stderr).toEqual([]);
			expect(captured.result.map((report) => report.command)).toEqual([
				'init',
				'rename',
				'dates',
				'verify',
			]);
			for (const report of captured.result) expect(report.schemaVersion).toBe(2);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('an already-aborted signal returns an interrupted report before work starts', async () => {
		const controller = new AbortController();
		controller.abort();
		const report = await syncArchive({
			signal: controller.signal,
			targetPath: 'C:/archive',
			token: 'test-token',
		});

		expect(report.exitCode).toBe(130);
		expect(report.interrupted).toBe(true);
		expect(report.findings).toContainEqual(
			expect.objectContaining({ code: 'interrupted', severity: 'warning' })
		);
		expect(mockPaginate).not.toHaveBeenCalled();
	});

	test('aborting from progress stops sync before a repository operation starts', async () => {
		mockPaginate.mockResolvedValue([mockStarredRepository('repo-a', 101)]);
		const controller = new AbortController();
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-api-abort-'));
		try {
			writeManagedArchiveConfig(target);
			const report = await syncArchive({
				concurrency: 1,
				onProgress: (message) => {
					if (message.includes('Syncing 1/1')) controller.abort();
				},
				signal: controller.signal,
				targetPath: target,
				token: 'test-token',
			});

			expect(report.exitCode).toBe(130);
			expect(report.interrupted).toBe(true);
			expect(report.checkouts[0]).toEqual(
				expect.objectContaining({ name: 'repo-a--example', outcome: 'skipped' })
			);
			expect(mockExecFile).not.toHaveBeenCalled();
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('aborting from dry-run progress stops before repository inspection', async () => {
		mockPaginate.mockResolvedValue([mockStarredRepository('repo-a', 101)]);
		const controller = new AbortController();
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-api-dry-abort-'));
		try {
			writeManagedArchiveConfig(target);
			const report = await syncArchive({
				dryRun: true,
				onProgress: (message) => {
					if (message.includes('Syncing 1/1')) controller.abort();
				},
				signal: controller.signal,
				targetPath: target,
				token: 'test-token',
			});

			expect(report.exitCode).toBe(130);
			expect(report.checkouts[0]?.findings[0]?.code).toBe('interrupted-before-inspection');
			expect(report.checkouts[0]?.plannedOutcome).toBeUndefined();
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('continues valid synchronization when another checkout has invalid identity', async () => {
		mockPaginate.mockResolvedValue([mockStarredRepository('repo-a', 101)]);

		for (const dryRun of [false, true]) {
			const target = mkdtempSync(path.join(tmpdir(), 'starsync-partial-invalid-'));
			try {
				writeManagedArchiveConfig(target);
				createCheckout(target, 'invalid--example');
				mockSuccessfulCloneAndDateOperations();

				const report = await syncArchive({
					concurrency: 1,
					dryRun,
					targetPath: target,
					token: 'test-token',
				});
				const byName = new Map(
					report.checkouts.map((checkout) => [checkout.name, checkout])
				);

				expect(report.exitCode).toBe(1);
				expect(report.checkouts).toHaveLength(2);
				expect(byName.get('invalid--example')).toEqual(
					expect.objectContaining({ lifecycle: 'blocked', outcome: 'failed' })
				);
				expect(byName.get('invalid--example')?.findings[0]?.code).toBe(
					'invalid-identity-metadata'
				);
				expect(byName.get('repo-a--example')).toEqual(
					expect.objectContaining(
						dryRun
							? { outcome: 'skipped', plannedOutcome: 'added' }
							: { lifecycle: 'active', outcome: 'added' }
					)
				);
				expect(existsSync(path.join(target, 'invalid--example'))).toBe(true);
				expect(existsSync(path.join(target, 'repo-a--example'))).toBe(!dryRun);
			} finally {
				rmSync(target, { force: true, recursive: true });
			}
		}
	});

	test('reports valid retained checkouts alongside invalid managed checkouts', async () => {
		mockPaginate.mockResolvedValue([]);
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-partial-retained-'));
		try {
			writeManagedArchiveConfig(target);
			createCheckout(target, 'invalid--example');
			createCheckout(target, 'retained--example');
			mockManagedCheckoutIdentity('retained--example', 102, 'example/retained');

			const report = await syncArchive({
				concurrency: 1,
				targetPath: target,
				token: 'test-token',
			});
			const byName = new Map(report.checkouts.map((checkout) => [checkout.name, checkout]));

			expect(report.exitCode).toBe(1);
			expect(report.checkouts).toHaveLength(2);
			expect(byName.get('invalid--example')).toEqual(
				expect.objectContaining({ lifecycle: 'blocked', outcome: 'failed' })
			);
			expect(byName.get('retained--example')).toEqual(
				expect.objectContaining({ lifecycle: 'retained', outcome: 'skipped' })
			);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});
});

describe('managed archive initialization', () => {
	test('initializes an empty directory with only archive format and authenticated owner', async () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-init-'));
		try {
			mockGetAuthenticated.mockResolvedValue({
				data: { id: 42, login: 'octocat' },
			});

			const report = await initArchive({
				targetPath: target,
				token: 'secret-test-token',
			});
			const configText = readFileSync(path.join(target, '.starsync', 'config.json'), 'utf-8');

			expect(report.exitCode).toBe(0);
			expect(report.findings).toContainEqual(
				expect.objectContaining({ code: 'archive-initialized', severity: 'info' })
			);
			expect(JSON.parse(configText)).toEqual({
				archiveFormat: 2,
				owner: { id: 42, login: 'octocat' },
			});
			expect(Object.keys(JSON.parse(configText) as Record<string, unknown>).sort()).toEqual([
				'archiveFormat',
				'owner',
			]);
			expect(configText).not.toContain('secret-test-token');
			expect(readdirSync(target)).toEqual(['.starsync']);
			expect(inspectArchive(target).kind).toBe('current');
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('refuses missing, non-empty, and unauthenticated targets without config writes', async () => {
		const missing = path.join(tmpdir(), `starsync-init-missing-${crypto.randomUUID()}`);
		const nonEmpty = mkdtempSync(path.join(tmpdir(), 'starsync-init-nonempty-'));
		try {
			writeFileSync(path.join(nonEmpty, 'existing.txt'), 'keep me');

			const missingTarget = await initArchive({ targetPath: missing, token: 'test-token' });
			const nonEmptyTarget = await initArchive({
				targetPath: nonEmpty,
				token: 'test-token',
			});
			const missingToken = await initArchive({ targetPath: nonEmpty, token: '' });

			expect(missingTarget.findings[0]?.code).toBe('target-not-found');
			expect(nonEmptyTarget.findings[0]?.code).toBe('target-not-empty');
			expect(missingToken.findings[0]?.code).toBe('missing-token');
			expect(readdirSync(nonEmpty)).toEqual(['existing.txt']);
			expect(mockGetAuthenticated).not.toHaveBeenCalled();
		} finally {
			rmSync(nonEmpty, { force: true, recursive: true });
		}
	});

	test('rejects sync for another account and never rewrites owner metadata', async () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-owner-mismatch-'));
		try {
			writeManagedArchiveConfig(target, { id: 7, login: 'original-owner' });
			const configPath = path.join(target, '.starsync', 'config.json');
			const configBefore = readFileSync(configPath, 'utf-8');
			mockGetAuthenticated.mockResolvedValue({
				data: { id: 8, login: 'different-owner' },
			});

			const report = await syncArchive({
				dryRun: true,
				targetPath: target,
				token: 'test-token',
			});

			expect(report.exitCode).toBe(1);
			expect(report.findings[0]?.code).toBe('archive-owner-mismatch');
			expect(mockPaginate).not.toHaveBeenCalled();
			expect(readFileSync(configPath, 'utf-8')).toBe(configBefore);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('rejects rename application for another account before resolving repositories', async () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-rename-owner-mismatch-'));
		try {
			writeManagedArchiveConfig(target, { id: 7, login: 'original-owner' });
			mockGetAuthenticated.mockResolvedValue({
				data: { id: 8, login: 'different-owner' },
			});

			const report = await renameArchive({
				apply: true,
				targetPath: target,
				token: 'test-token',
			});

			expect(report.exitCode).toBe(1);
			expect(report.findings[0]?.code).toBe('archive-owner-mismatch');
			expect(mockGetRepository).not.toHaveBeenCalled();
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('accepts the same account ID after a login rename without upgrading config', async () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-owner-rename-'));
		try {
			writeManagedArchiveConfig(target, { id: 7, login: 'original-owner' });
			const configPath = path.join(target, '.starsync', 'config.json');
			const configBefore = readFileSync(configPath, 'utf-8');
			mockGetAuthenticated.mockResolvedValue({
				data: { id: 7, login: 'renamed-owner' },
			});
			mockPaginate.mockResolvedValue([]);

			const report = await syncArchive({
				dryRun: true,
				targetPath: target,
				token: 'test-token',
			});

			expect(report.exitCode).toBe(0);
			expect(readFileSync(configPath, 'utf-8')).toBe(configBefore);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('blocks modifying commands for unsupported and invalid archive configs', async () => {
		const cases = [
			{
				code: 'archive-format-unsupported',
				config: { archiveFormat: 1, owner: { id: 7, login: 'archive-owner' } },
				prefix: 'starsync-older-managed-',
			},
			{
				code: 'archive-format-unsupported',
				config: { archiveFormat: 3, owner: { id: 7, login: 'archive-owner' } },
				prefix: 'starsync-newer-managed-',
			},
			{
				code: 'invalid-archive-config',
				config: {
					archiveFormat: 2,
					owner: { id: 7, login: 'archive-owner' },
					unexpected: true,
				},
				prefix: 'starsync-invalid-managed-',
			},
		];

		for (const testCase of cases) {
			const target = mkdtempSync(path.join(tmpdir(), testCase.prefix));
			try {
				mkdirSync(path.join(target, '.starsync'));
				writeFileSync(
					path.join(target, '.starsync', 'config.json'),
					JSON.stringify(testCase.config)
				);

				const syncReport = await syncArchive({
					dryRun: true,
					targetPath: target,
					token: 'test-token',
				});
				const datesReport = await normalizeArchiveDates({
					dryRun: true,
					targetPath: target,
				});

				expect(syncReport.findings[0]?.code).toBe(testCase.code);
				expect(datesReport.findings[0]?.code).toBe(testCase.code);
				expect(mockGetAuthenticated).not.toHaveBeenCalled();
			} finally {
				rmSync(target, { force: true, recursive: true });
			}
		}
	});
});

describe('sync --dry-run', () => {
	let savedToken: string | undefined;

	afterEach(() => {
		if (savedToken === undefined) {
			delete process.env.GITHUB_TOKEN;
		} else {
			process.env.GITHUB_TOKEN = savedToken;
		}
	});

	test('queries stars and reports would-clone without calling git', async () => {
		savedToken = process.env.GITHUB_TOKEN;
		process.env.GITHUB_TOKEN = 'test-token';
		mockPaginate.mockResolvedValue([mockStarredRepository('repo-a', 101)]);
		mockExecFileSync.mockReturnValue(undefined);

		const target = mkdtempSync(path.join(tmpdir(), 'starsync-dryrun-'));
		try {
			writeManagedArchiveConfig(target);
			const captured = await captureConsole(() =>
				dispatchSync(['--json', target, '--dry-run'])
			);
			const report = parseReport(captured.stdout);
			expect(captured.result).toBe(0);
			expect(report.checkouts[0]?.findings).toContainEqual(
				expect.objectContaining({ code: 'date-update-planned' })
			);
			// In dry-run mode, no git clone/pull should be called
			expect(
				mockExecFileSync.mock.calls.some((call) =>
					(call[1] as string[]).some((arg) => ['clone', 'fetch', 'merge'].includes(arg))
				)
			).toBe(false);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('reports would-pull for existing repos without calling git pull', async () => {
		savedToken = process.env.GITHUB_TOKEN;
		process.env.GITHUB_TOKEN = 'test-token';
		mockPaginate.mockResolvedValue([mockStarredRepository('repo-a', 101)]);

		const target = mkdtempSync(path.join(tmpdir(), 'starsync-dryrun-'));
		try {
			writeManagedArchiveConfig(target);
			mkdirSync(path.join(target, 'repo-a--example', '.git'), { recursive: true });
			mockManagedCheckoutIdentity('repo-a--example', 101, 'example/repo-a');

			const report = await syncArchive({
				dryRun: true,
				targetPath: target,
				token: 'test-token',
			});
			expect(report.exitCode).toBe(0);
			expect(report.checkouts[0]?.findings).toContainEqual(
				expect.objectContaining({ code: 'date-update-planned' })
			);
			expect(
				mockExecFile.mock.calls.some((call) =>
					(call[1] as string[]).some((arg) => ['clone', 'fetch', 'merge'].includes(arg))
				)
			).toBe(false);
			expect(
				mockExecFileSync.mock.calls.some((call) =>
					(call[1] as string[]).some((arg) => ['clone', 'fetch', 'merge'].includes(arg))
				)
			).toBe(false);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('matches a renamed repository by stable identity and reports a pending rename', async () => {
		savedToken = process.env.GITHUB_TOKEN;
		process.env.GITHUB_TOKEN = 'test-token';
		mockPaginate.mockResolvedValue([mockStarredRepository('renamed-repo', 101, 'new-owner')]);

		const target = mkdtempSync(path.join(tmpdir(), 'starsync-renamed-dryrun-'));
		try {
			writeManagedArchiveConfig(target);
			mkdirSync(path.join(target, 'original--old-owner', '.git'), { recursive: true });
			mockManagedCheckoutIdentity('original--old-owner', 101, 'old-owner/original');

			const report = await syncArchive({
				dryRun: true,
				targetPath: target,
				token: 'test-token',
			});

			expect(report.exitCode).toBe(0);
			expect(report.checkouts[0]).toEqual(
				expect.objectContaining({
					name: 'original--old-owner',
					pendingRename: true,
					plannedOutcome: 'updated',
				})
			);
			expect(
				mockExecFile.mock.calls.some((call) =>
					(call[1] as string[]).some((arg) => arg === 'clone')
				)
			).toBe(false);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});
});

describe('parseArgs --dry-run', () => {
	test('accepts --dry-run flag', () => {
		expect(parseArgs(['--dry-run'])).toEqual({
			concurrency: 4,
			dryRun: true,
			help: false,
			json: false,
			targetPath: null,
		});
		expect(parseArgs(['--dry-run', 'repos'])).toEqual({
			concurrency: 4,
			dryRun: true,
			help: false,
			json: false,
			targetPath: 'repos',
		});
	});
});

describe('subcommand dispatch', () => {
	test('isSubcommand recognizes all six subcommands', async () => {
		const { isSubcommand } = await import('../src/lib/cli-utils.ts');
		expect(isSubcommand('sync')).toBe(true);
		expect(isSubcommand('verify')).toBe(true);
		expect(isSubcommand('rename')).toBe(true);
		expect(isSubcommand('dates')).toBe(true);
		expect(isSubcommand('init')).toBe(true);
		expect(isSubcommand('unlock')).toBe(true);
	});

	test('isSubcommand rejects non-subcommand strings', async () => {
		const { isSubcommand } = await import('../src/lib/cli-utils.ts');
		expect(isSubcommand('pull')).toBe(false);
		expect(isSubcommand('--help')).toBe(false);
		expect(isSubcommand('')).toBe(false);
		expect(isSubcommand('target-path')).toBe(false);
	});

	test('dispatchVerify exits 1 for a missing target', async () => {
		const { dispatchVerify } = await import('../src/lib/subcommands.ts');
		const exitCode = await dispatchVerify(['./nonexistent-test-dir-xyz']);
		expect(exitCode).toBe(1);
	});

	test('dispatchVerify --help exits 0', async () => {
		const { dispatchVerify } = await import('../src/lib/subcommands.ts');
		const exitCode = await dispatchVerify(['--help']);
		expect(exitCode).toBe(0);
	});

	test('dispatchVerify rejects unknown flags with exit 2', async () => {
		const { dispatchVerify } = await import('../src/lib/subcommands.ts');
		const exitCode = await dispatchVerify(['--bogus']);
		expect(exitCode).toBe(2);
	});

	test('dispatchRename exits 1 when a preview cannot run', async () => {
		const { dispatchRename } = await import('../src/lib/subcommands.ts');
		const originalToken = process.env.GITHUB_TOKEN;
		try {
			delete process.env.GITHUB_TOKEN;
			const exitCode = await dispatchRename(['C:/archive']);
			expect(exitCode).toBe(1);
		} finally {
			if (originalToken !== undefined) process.env.GITHUB_TOKEN = originalToken;
		}
	});

	test('dispatchRename --apply completes an empty current archive', async () => {
		const { dispatchRename } = await import('../src/lib/subcommands.ts');
		const savedToken = process.env.GITHUB_TOKEN;
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-empty-rename-'));
		process.env.GITHUB_TOKEN = 'test-token';
		try {
			writeManagedArchiveConfig(target);
			const exitCode = await dispatchRename(['--apply', target]);
			expect(exitCode).toBe(0);
		} finally {
			if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = savedToken;
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('dispatchRename --help exits 0', async () => {
		const { dispatchRename } = await import('../src/lib/subcommands.ts');
		const exitCode = await dispatchRename(['--help']);
		expect(exitCode).toBe(0);
	});

	test('dispatchInit requires an explicit target', async () => {
		const { dispatchInit } = await import('../src/lib/subcommands.ts');
		const savedTarget = process.env.TARGET_PATH;
		delete process.env.TARGET_PATH;
		try {
			const exitCode = await dispatchInit([]);
			expect(exitCode).toBe(2);
		} finally {
			if (savedTarget !== undefined) process.env.TARGET_PATH = savedTarget;
		}
	});

	test('dispatchInit initializes an explicitly targeted archive', async () => {
		const { dispatchInit } = await import('../src/lib/subcommands.ts');
		const savedToken = process.env.GITHUB_TOKEN;
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-dispatch-init-'));
		process.env.GITHUB_TOKEN = 'test-token';
		try {
			const captured = await captureConsole(() => dispatchInit(['--json', target]));
			const report = parseReport(captured.stdout);

			expect(captured.result).toBe(0);
			expect(report.findings[0]?.code).toBe('archive-initialized');
			expect(readdirSync(target)).toEqual(['.starsync']);
		} finally {
			if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = savedToken;
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('dispatchInit --help exits 0', async () => {
		const { dispatchInit } = await import('../src/lib/subcommands.ts');
		const exitCode = await dispatchInit(['--help']);
		expect(exitCode).toBe(0);
	});

	test('dispatchUnlock exits 0 when the archive has no lock', async () => {
		const { dispatchUnlock } = await import('../src/lib/subcommands.ts');
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-dispatch-unlock-'));
		try {
			const exitCode = dispatchUnlock([target]);
			expect(exitCode).toBe(0);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('dispatchUnlock --help exits 0', async () => {
		const { dispatchUnlock } = await import('../src/lib/subcommands.ts');
		const exitCode = dispatchUnlock(['--help']);
		expect(exitCode).toBe(0);
	});

	test('dispatchDates exits 1 for nonexistent target path', async () => {
		const { dispatchDates } = await import('../src/lib/subcommands.ts');
		const exitCode = await dispatchDates(['./nonexistent-test-dir-xyz']);
		expect(exitCode).toBe(1);
	});

	test('dispatchDates rejects an empty or quoted-empty target path', async () => {
		const { dispatchDates } = await import('../src/lib/subcommands.ts');
		const savedTarget = process.env.TARGET_PATH;
		try {
			delete process.env.TARGET_PATH;
			expect(await dispatchDates([''])).toBe(2);
			// An explicit empty target is invalid input and never falls back to TARGET_PATH.
			process.env.TARGET_PATH = tmpdir();
			expect(await dispatchDates(['""'])).toBe(2);
		} finally {
			if (savedTarget === undefined) {
				delete process.env.TARGET_PATH;
			} else {
				process.env.TARGET_PATH = savedTarget;
			}
		}
	});

	test('usage error reports keep the requested dry run mode', async () => {
		const { dispatchDates } = await import('../src/lib/subcommands.ts');
		const savedTarget = process.env.TARGET_PATH;
		delete process.env.TARGET_PATH;
		try {
			const captured = await captureConsole(() => dispatchDates(['--json', '--dry-run', '']));
			expect(captured.result).toBe(2);
			expect(parseReport(captured.stdout).dryRun).toBe(true);
		} finally {
			if (savedTarget !== undefined) process.env.TARGET_PATH = savedTarget;
		}
	});

	test('dispatchDates --help exits 0', async () => {
		const { dispatchDates } = await import('../src/lib/subcommands.ts');
		const exitCode = await dispatchDates(['--help']);
		expect(exitCode).toBe(0);
	});

	test('dispatchDates processes git repos in --dry-run mode', async () => {
		const { dispatchDates } = await import('../src/lib/subcommands.ts');
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-subcmd-'));
		try {
			writeManagedArchiveConfig(target);
			mkdirSync(path.join(target, 'repo-a'));
			mkdirSync(path.join(target, 'repo-a', '.git'));
			mkdirSync(path.join(target, 'repo-b'));
			mockManagedCheckoutIdentity('repo-a', 101, 'example/repo-a');

			const exitCode = await dispatchDates([target, '--dry-run']);
			expect(exitCode).toBe(0);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('dispatchSync --help exits 0', async () => {
		const { dispatchSync } = await import('../src/lib/subcommands.ts');
		const exitCode = await dispatchSync(['--help']);
		expect(exitCode).toBe(0);
	});

	test('sync dispatch stays independent of the public index while preserving its API', async () => {
		const subcommandsSource = readFileSync(
			new URL('../src/lib/subcommands.ts', import.meta.url),
			'utf8'
		);
		const { dispatchSync } = await import('../src/lib/subcommands.ts');
		const defaultParsed: ParsedArgs = parseArgs([]);
		const parsed: ParsedArgs = parseArgs(['--concurrency=2']);
		const captured = await captureConsole(() => dispatchSync(['--help']));

		expect(subcommandsSource).not.toMatch(/from\s+['"]\.\.\/index\.ts['"]/);
		expect(defaultParsed.concurrency).toBe(4);
		expect(parsed.concurrency).toBe(2);
		expect(captured.result).toBe(0);
		expect(captured.stdout).toEqual([SYNC_HELP_TEXT]);
	});
});

describe('secret safety', () => {
	test('hasEmbeddedCredentials detects user:password@ in HTTPS URLs', () => {
		expect(hasEmbeddedCredentials('https://user:pass@github.com/repo.git')).toBe(true);
		expect(hasEmbeddedCredentials('https://user:token@github.com/repo.git')).toBe(true);
	});

	test('hasEmbeddedCredentials detects bare token@ in HTTPS URLs', () => {
		expect(hasEmbeddedCredentials('https://ghp_abc123@github.com/repo.git')).toBe(true);
	});

	test('hasEmbeddedCredentials returns false for clean HTTPS URLs', () => {
		expect(hasEmbeddedCredentials('https://github.com/owner/repo.git')).toBe(false);
	});

	test('hasEmbeddedCredentials returns false for SSH URLs', () => {
		expect(hasEmbeddedCredentials('git@github.com:owner/repo.git')).toBe(false);
	});

	test('sanitizeUrl strips user:password from HTTPS URLs', () => {
		expect(sanitizeUrl('https://user:pass@github.com/owner/repo.git')).toBe(
			'https://github.com/owner/repo.git'
		);
	});

	test('sanitizeUrl strips bare token from HTTPS URLs', () => {
		expect(sanitizeUrl('https://ghp_token123@github.com/owner/repo.git')).toBe(
			'https://github.com/owner/repo.git'
		);
	});

	test('sanitizeUrl leaves clean URLs unchanged', () => {
		expect(sanitizeUrl('https://github.com/owner/repo.git')).toBe(
			'https://github.com/owner/repo.git'
		);
	});

	test('sanitizeUrl leaves SSH URLs unchanged', () => {
		expect(sanitizeUrl('git@github.com:owner/repo.git')).toBe('git@github.com:owner/repo.git');
	});

	test('sanitizeMessage strips credentials from URLs in error messages', () => {
		const msg =
			'fatal: could not read Username for https://user:pass@github.com/owner/repo.git';
		const sanitized = sanitizeMessage(msg);
		expect(sanitized).not.toContain('user:pass');
		expect(sanitized).toContain('https://github.com/owner/repo.git');
	});

	test('sanitizeMessage redacts GitHub PAT tokens', () => {
		const token = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
		const msg = `Authentication failed for ${token}`;
		const sanitized = sanitizeMessage(msg);
		expect(sanitized).not.toContain(token);
		expect(sanitized).toContain('[REDACTED]');
	});

	test('sanitizeMessage redacts fine-grained PAT tokens', () => {
		const token = 'github_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
		const msg = `Authentication failed for ${token}`;
		const sanitized = sanitizeMessage(msg);
		expect(sanitized).not.toContain(token);
	});

	test('isGitAuthError detects authentication failure messages', () => {
		expect(isGitAuthError('fatal: Authentication failed for repository')).toBe(true);
		expect(isGitAuthError("fatal: could not read Username for 'https://...'")).toBe(true);
		expect(isGitAuthError('error: terminal prompts disabled')).toBe(true);
	});

	test('isGitAuthError returns false for non-auth errors', () => {
		expect(isGitAuthError('CONFLICT: merge conflict')).toBe(false);
		expect(isGitAuthError('fatal: repository not found')).toBe(false);
	});

	test('extractHost parses HTTPS URLs', () => {
		expect(extractHost('https://github.com/owner/repo.git')).toBe('github.com');
		expect(extractHost('https://git.internal.corp/repo.git')).toBe('git.internal.corp');
	});

	test('extractHost parses SSH URLs', () => {
		expect(extractHost('git@github.com:owner/repo.git')).toBe('github.com');
		expect(extractHost('ssh://git@ghe.corp:22/owner/repo.git')).toBe('ghe.corp');
	});

	test('extractHost returns null for unrecognized formats', () => {
		expect(extractHost('not a url')).toBeNull();
	});

	test('isGitHubDotComUrl returns true for github.com', () => {
		expect(isGitHubDotComUrl('https://github.com/owner/repo.git')).toBe(true);
		expect(isGitHubDotComUrl('git@github.com:owner/repo.git')).toBe(true);
		expect(isGitHubDotComUrl('https://www.github.com/owner/repo.git')).toBe(true);
	});

	test('isGitHubDotComUrl returns false for GitHub Enterprise Server', () => {
		expect(isGitHubDotComUrl('https://ghe.corp.com/owner/repo.git')).toBe(false);
		expect(isGitHubDotComUrl('git@ghe.corp.com:owner/repo.git')).toBe(false);
	});

	test('isGitHubDotComUrl returns false for non-GitHub hosts', () => {
		expect(isGitHubDotComUrl('https://gitlab.com/owner/repo.git')).toBe(false);
	});
});

describe('parseArgs --concurrency', () => {
	test('defaults to 4', () => {
		expect(parseArgs([]).concurrency).toBe(4);
	});

	test('accepts --concurrency=1 (deterministic mode)', () => {
		expect(parseArgs(['--concurrency=1']).concurrency).toBe(1);
	});

	test('accepts --concurrency=8 (max)', () => {
		expect(parseArgs(['--concurrency=8']).concurrency).toBe(8);
	});

	test('accepts --concurrency with other args', () => {
		const result = parseArgs(['--concurrency=2', '--dry-run', '/tmp/repos']);
		expect(result.concurrency).toBe(2);
		expect(result.dryRun).toBe(true);
		expect(result.targetPath).toBe('/tmp/repos');
	});

	test('rejects --concurrency=0', () => {
		expect(() => parseArgs(['--concurrency=0'])).toThrow('must be an integer from 1 to 8');
	});

	test('rejects --concurrency=9', () => {
		expect(() => parseArgs(['--concurrency=9'])).toThrow('must be an integer from 1 to 8');
	});

	test('rejects --concurrency=abc', () => {
		expect(() => parseArgs(['--concurrency=abc'])).toThrow('must be an integer from 1 to 8');
	});

	test('rejects bare --concurrency without value', () => {
		expect(() => parseArgs(['--concurrency'])).toThrow('--concurrency requires a value');
	});
});

describe('Git subprocess environment', () => {
	test('buildGitEnvironment keeps only allowlisted platform and Git variables', async () => {
		const { buildGitEnvironment } = await import('../src/lib/git-exec.ts');
		const environment = buildGitEnvironment(
			{
				AWS_SECRET_ACCESS_KEY: 'aws-secret',
				COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
				DB_PASSWORD: 'database-secret',
				GITHUB_TOKEN: 'github-secret',
				HOME: '/home/starsync',
				HTTP_PROXY: 'http://proxy.example',
				NPM_TOKEN: 'npm-secret',
				PATH: '/usr/local/bin',
				SERVICE_API_KEY: 'service-secret',
				SystemRoot: 'C:\\Windows',
				UNRELATED_SETTING: 'not-required-by-git',
			},
			{
				credential_helper: 'override-secret',
				GIT_OPTIONAL_LOCKS: '0',
				GIT_TERMINAL_PROMPT: '1',
				PaSsWd: 'override-secret',
				PATH: '/opt/git/bin',
			}
		);

		expect(environment).toEqual({
			COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
			GIT_OPTIONAL_LOCKS: '0',
			GIT_TERMINAL_PROMPT: '0',
			HOME: '/home/starsync',
			HTTP_PROXY: 'http://proxy.example',
			PATH: '/opt/git/bin',
			SystemRoot: 'C:\\Windows',
		});
	});

	test('runGit filters source and override secrets at the async process boundary', async () => {
		const { runGit } = await import('../src/lib/git-exec.ts');
		await runGit(['status', '--porcelain'], {
			cwd: '/tmp/repository',
			env: {
				AWS_SECRET_ACCESS_KEY: 'aws-secret',
				DB_PASSWORD: 'database-secret',
				GITHUB_TOKEN: 'github-secret',
				HOME: '/home/starsync',
				NPM_TOKEN: 'npm-secret',
				PATH: '/opt/git/bin',
				SERVICE_API_KEY: 'service-secret',
				SystemRoot: 'C:\\Windows',
			},
		});

		const options = mockExecFile.mock.calls.at(-1)?.[2] as
			{ env?: NodeJS.ProcessEnv } | undefined;
		expect(options?.env).toEqual(
			expect.objectContaining({
				GIT_TERMINAL_PROMPT: '0',
				HOME: '/home/starsync',
				PATH: '/opt/git/bin',
				SystemRoot: 'C:\\Windows',
			})
		);
		for (const key of [
			'AWS_SECRET_ACCESS_KEY',
			'DB_PASSWORD',
			'GITHUB_TOKEN',
			'NPM_TOKEN',
			'SERVICE_API_KEY',
		]) {
			expect(options?.env).not.toHaveProperty(key);
		}
	});
});

describe('git-exec error classification', () => {
	test('isTransientGitError detects network timeouts', async () => {
		const { isTransientGitError } = await import('../src/lib/git-exec.ts');
		expect(isTransientGitError('fatal: unable to access: Connection timed out')).toBe(true);
	});

	test('isTransientGitError detects RPC failures', async () => {
		const { isTransientGitError } = await import('../src/lib/git-exec.ts');
		expect(isTransientGitError('error: RPC failed; curl 56 GnuHTTP')).toBe(true);
	});

	test('isTransientGitError does NOT classify auth failures as transient', async () => {
		const { isTransientGitError } = await import('../src/lib/git-exec.ts');
		expect(isTransientGitError('fatal: Authentication failed for repository')).toBe(false);
	});

	test('isTransientGitError does NOT classify repository-not-found as transient', async () => {
		const { isTransientGitError } = await import('../src/lib/git-exec.ts');
		expect(isTransientGitError('fatal: repository not found')).toBe(false);
	});

	test('isTransientGitError does NOT classify merge conflicts as transient', async () => {
		const { isTransientGitError } = await import('../src/lib/git-exec.ts');
		expect(isTransientGitError('CONFLICT: merge conflict in file.ts')).toBe(false);
	});

	test('isTransientGitError does NOT classify corrupt repo as transient', async () => {
		const { isTransientGitError } = await import('../src/lib/git-exec.ts');
		expect(isTransientGitError('fatal: bad object refs/heads/main')).toBe(false);
	});
});

describe('api-retry', () => {
	test('retries 5xx errors up to maxRetries', async () => {
		const { withApiRetry } = await import('../src/lib/api-retry.ts');
		let calls = 0;
		const result = await withApiRetry(
			async () => {
				calls++;
				if (calls < 2) {
					throw Object.assign(new Error('Server error'), {
						headers: { 'retry-after': '0' },
						status: 500,
					});
				}
				return 'ok';
			},
			{ maxRetries: 2 }
		);
		expect(result).toBe('ok');
		expect(calls).toBe(2);
	});

	test('does NOT retry 401 authentication errors', async () => {
		const { withApiRetry } = await import('../src/lib/api-retry.ts');
		let calls = 0;
		await expect(
			withApiRetry(
				async () => {
					calls++;
					throw Object.assign(new Error('Bad credentials'), { status: 401 });
				},
				{ maxRetries: 2 }
			)
		).rejects.toThrow('Bad credentials');
		expect(calls).toBe(1);
	});

	test('does NOT retry 404 not-found errors', async () => {
		const { withApiRetry } = await import('../src/lib/api-retry.ts');
		let calls = 0;
		await expect(
			withApiRetry(
				async () => {
					calls++;
					throw Object.assign(new Error('Not Found'), { status: 404 });
				},
				{ maxRetries: 2 }
			)
		).rejects.toThrow('Not Found');
		expect(calls).toBe(1);
	});

	test('does NOT retry 422 validation errors', async () => {
		const { withApiRetry } = await import('../src/lib/api-retry.ts');
		let calls = 0;
		await expect(
			withApiRetry(
				async () => {
					calls++;
					throw Object.assign(new Error('Validation Failed'), { status: 422 });
				},
				{ maxRetries: 2 }
			)
		).rejects.toThrow('Validation Failed');
		expect(calls).toBe(1);
	});

	test('retries 429 rate-limit errors', async () => {
		const { withApiRetry } = await import('../src/lib/api-retry.ts');
		let calls = 0;
		const result = await withApiRetry(
			async () => {
				calls++;
				if (calls < 2) {
					throw Object.assign(new Error('Rate limited'), {
						headers: { 'retry-after': '0' },
						status: 429,
					});
				}
				return 'ok';
			},
			{ maxRetries: 2 }
		);
		expect(result).toBe('ok');
		expect(calls).toBe(2);
	});

	test('exhausts retries and throws last error', async () => {
		const { withApiRetry } = await import('../src/lib/api-retry.ts');
		let calls = 0;
		await expect(
			withApiRetry(
				async () => {
					calls++;
					throw Object.assign(new Error('Server error'), {
						headers: { 'retry-after': '0' },
						status: 503,
					});
				},
				{ maxRetries: 1 }
			)
		).rejects.toThrow('Server error');
		expect(calls).toBe(2); // initial + 1 retry
	});
});

describe('refresh pipeline', () => {
	test('refreshes a clean secondary branch onto the GitHub default branch', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-default-refresh-'));
		try {
			const fixture = createRealRefreshFixture(root);
			runRealGit(['switch', '--create', 'secondary'], fixture.checkout);
			addRealCommit(fixture.seed, 'REMOTE.md', 'remote update\n', 'remote update');
			pushRealBranch(fixture, 'main');

			const result = runRealRefresh(fixture, 'main');

			expect(result.outcome).toBe('updated');
			expect(runRealGit(['branch', '--show-current'], fixture.checkout)).toBe('main');
			expect(readFileSync(path.join(fixture.checkout, 'REMOTE.md'), 'utf8')).toContain(
				'remote update'
			);
			expect(runRealGit(['rev-parse', 'HEAD'], fixture.checkout)).toBe(
				runRealGit(['rev-parse', 'refs/remotes/origin/main'], fixture.checkout)
			);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('follows a renamed GitHub default branch even when the old branch still exists', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-renamed-default-'));
		try {
			const fixture = createRealRefreshFixture(root);
			runRealGit(['switch', '--create', 'trunk'], fixture.seed);
			addRealCommit(fixture.seed, 'TRUNK.md', 'renamed default\n', 'rename default');
			pushRealBranch(fixture, 'trunk');

			const result = runRealRefresh(fixture, 'trunk');

			expect(result.outcome).toBe('updated');
			expect(runRealGit(['branch', '--show-current'], fixture.checkout)).toBe('trunk');
			expect(readFileSync(path.join(fixture.checkout, 'TRUNK.md'), 'utf8')).toContain(
				'renamed default'
			);
			expect(runRealGit(['rev-parse', 'HEAD'], fixture.checkout)).toBe(
				runRealGit(['rev-parse', 'refs/remotes/origin/trunk'], fixture.checkout)
			);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('creates a missing local default branch from its remote-tracking ref', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-missing-default-'));
		try {
			const fixture = createRealRefreshFixture(root);
			runRealGit(['branch', '--move', 'main', 'secondary'], fixture.checkout);

			const result = runRealRefresh(fixture, 'main');

			expect(result.outcome).toBe('updated');
			expect(runRealGit(['branch', '--show-current'], fixture.checkout)).toBe('main');
			expect(runRealGit(['rev-parse', 'main'], fixture.checkout)).toBe(
				runRealGit(['rev-parse', 'refs/remotes/origin/main'], fixture.checkout)
			);
			expect(runRealGit(['rev-parse', 'secondary'], fixture.checkout)).toBe(
				runRealGit(['rev-parse', 'main'], fixture.checkout)
			);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('blocks dirty secondary branches without changing their files or branch', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-dirty-default-'));
		try {
			const fixture = createRealRefreshFixture(root);
			runRealGit(['switch', '--create', 'secondary'], fixture.checkout);
			const localFile = path.join(fixture.checkout, 'LOCAL.txt');
			writeFileSync(localFile, 'preserve dirty work\n');

			const result = runRealRefresh(fixture, 'main');

			expect(result.outcome).toBe('blocked');
			expect(result.message).toContain('Local changes detected');
			expect(runRealGit(['branch', '--show-current'], fixture.checkout)).toBe('secondary');
			expect(readFileSync(localFile, 'utf8')).toBe('preserve dirty work\n');
			expect(runRealGit(['status', '--porcelain'], fixture.checkout)).toContain(
				'?? LOCAL.txt'
			);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('blocked refreshes preserve managed metadata when upstream labels changed', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-blocked-labels-'));
		try {
			const fixture = createRealRefreshFixture(root);
			runRealGit(['switch', '--create', 'secondary'], fixture.checkout);
			const localFile = path.join(fixture.checkout, 'LOCAL.txt');
			writeFileSync(localFile, 'preserve dirty work\n');
			const origin = runRealGit(['remote', 'get-url', 'origin'], fixture.checkout);
			const repositoryId = runRealGit(
				['config', '--local', '--get', 'starsync.repository-id'],
				fixture.checkout
			);
			const repositorySlug = runRealGit(
				['config', '--local', '--get', 'starsync.repository-slug'],
				fixture.checkout
			);

			const result = runRealRefresh(fixture, 'main', {
				cloneUrl: 'https://github.com/new-owner/renamed-repository.git',
				slug: 'new-owner/renamed-repository',
			});

			expect(result.outcome).toBe('blocked');
			expect(runRealGit(['remote', 'get-url', 'origin'], fixture.checkout)).toBe(origin);
			expect(
				runRealGit(
					['config', '--local', '--get', 'starsync.repository-id'],
					fixture.checkout
				)
			).toBe(repositoryId);
			expect(
				runRealGit(
					['config', '--local', '--get', 'starsync.repository-slug'],
					fixture.checkout
				)
			).toBe(repositorySlug);
			expect(runRealGit(['branch', '--show-current'], fixture.checkout)).toBe('secondary');
			expect(readFileSync(localFile, 'utf8')).toBe('preserve dirty work\n');
			expect(runRealGit(['status', '--porcelain'], fixture.checkout)).toContain(
				'?? LOCAL.txt'
			);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('blocks a divergent local default branch while preserving its commit and current branch', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-divergent-default-'));
		try {
			const fixture = createRealRefreshFixture(root);
			addRealCommit(fixture.checkout, 'LOCAL.txt', 'preserve commit\n', 'local commit');
			const localHash = runRealGit(['rev-parse', 'main'], fixture.checkout);
			runRealGit(['switch', '--create', 'secondary'], fixture.checkout);
			addRealCommit(fixture.seed, 'REMOTE.txt', 'remote commit\n', 'remote commit');
			pushRealBranch(fixture, 'main');

			const result = runRealRefresh(fixture, 'main');

			expect(result.outcome).toBe('blocked');
			expect(result.message).toContain('diverged');
			expect(runRealGit(['branch', '--show-current'], fixture.checkout)).toBe('secondary');
			expect(runRealGit(['rev-parse', 'main'], fixture.checkout)).toBe(localHash);
			expect(runRealGit(['show', 'main:LOCAL.txt'], fixture.checkout)).toBe(
				'preserve commit'
			);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('blocks missing and invalid remote default refs without changing branches', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-invalid-default-'));
		try {
			const fixture = createRealRefreshFixture(root);
			runRealGit(['switch', '--create', 'secondary'], fixture.checkout);

			const missingResult = runRealRefresh(fixture, 'missing');
			const invalidResult = runRealRefresh(fixture, 'bad..branch');

			expect(missingResult.outcome).toBe('blocked');
			expect(missingResult.message).toContain('unavailable');
			expect(invalidResult.outcome).toBe('blocked');
			expect(invalidResult.message).toContain('invalid');
			expect(runRealGit(['branch', '--show-current'], fixture.checkout)).toBe('secondary');
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('processRepository clones new repo and returns added', async () => {
		const { processRepository } = (await import('../src/lib/refresh.ts')) as {
			processRepository: (
				repo: {
					clone_url: string;
					defaultBranch: string;
					folderName: string;
					id: number;
					name: string;
					slug: string;
				},
				targetBase: string,
				isInterruptionRequested: () => boolean,
				options: { archiveOwnerId: number }
			) => Promise<{ name: string; outcome: string }>;
		};
		const repo = {
			clone_url: 'https://github.com/example/new-repo.git',
			defaultBranch: 'main',
			folderName: 'new-repo--example',
			id: 321,
			name: 'new-repo',
			slug: 'example/new-repo',
		};
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-staged-unit-'));
		writeManagedArchiveConfig(target);
		mockSuccessfulCloneAndDateOperations();
		try {
			const result = await processRepository(repo, target, () => false, {
				archiveOwnerId: 7,
			});
			expect(result.outcome).toBe('added');
			expect(result.name).toBe('new-repo--example');
			expect(existsSync(path.join(target, 'new-repo--example', '.git'))).toBe(true);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('processRepository clones to the canonical folder and records stable identity', async () => {
		const { processRepository } = await import('../src/lib/refresh.ts');
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-staged-metadata-'));
		writeManagedArchiveConfig(target);
		mockSuccessfulCloneAndDateOperations();
		try {
			const result = await processRepository(
				{
					clone_url: 'https://github.com/example/new-repo.git',
					defaultBranch: 'main',
					folderName: 'new-repo--example',
					id: 321,
					name: 'new-repo',
					slug: 'example/new-repo',
				},
				target,
				() => false,
				{ archiveOwnerId: 7 }
			);

			expect(result).toEqual(
				expect.objectContaining({ name: 'new-repo--example', outcome: 'added' })
			);
			expect(mockExecFile).toHaveBeenCalledWith(
				'git',
				[
					'clone',
					'https://github.com/example/new-repo.git',
					expect.stringMatching(/^\.starsync-checkout-/),
				],
				expect.objectContaining({ cwd: target }),
				expect.any(Function)
			);
			expect(mockExecFile).toHaveBeenCalledWith(
				'git',
				['fsck', '--full'],
				expect.objectContaining({
					cwd: expect.stringContaining('.starsync-checkout-'),
				}),
				expect.any(Function)
			);
			expect(mockExecFile).toHaveBeenCalledWith(
				'git',
				['config', '--local', 'starsync.repository-id', '321'],
				expect.objectContaining({
					cwd: expect.stringContaining('.starsync-checkout-'),
				}),
				expect.any(Function)
			);
			expect(mockExecFile).toHaveBeenCalledWith(
				'git',
				['config', '--local', 'starsync.repository-slug', 'example/new-repo'],
				expect.any(Object),
				expect.any(Function)
			);
			expect(
				readdirSync(target).filter((name) => name.startsWith('.starsync-checkout-'))
			).toEqual([]);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('staged clone preserves a destination that appears before publication', async () => {
		const { processRepository } = await import('../src/lib/refresh.ts');
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-staged-collision-'));
		const destination = path.join(target, 'new-repo--example');
		const marker = path.join(destination, 'user-owned.txt');
		writeManagedArchiveConfig(target);
		mockSuccessfulCloneAndDateOperations(undefined, {
			afterClone: () => {
				mkdirSync(destination);
				writeFileSync(marker, 'preserve');
			},
		});
		try {
			const result = await processRepository(
				{
					clone_url: 'https://github.com/example/new-repo.git',
					defaultBranch: 'main',
					folderName: 'new-repo--example',
					id: 321,
					name: 'new-repo',
					slug: 'example/new-repo',
				},
				target,
				() => false,
				{ archiveOwnerId: 7 }
			);

			expect(result.outcome).toBe('failed');
			expect(result.message).toContain('already occupied');
			expect(readFileSync(marker, 'utf8')).toBe('preserve');
			expect(
				readdirSync(target).filter((name) => name.startsWith('.starsync-checkout-'))
			).toEqual([]);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('staged clone retries once with fresh directories and redacts the final failure', async () => {
		const { processRepository } = await import('../src/lib/refresh.ts');
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-staged-retry-'));
		const attempts: string[] = [];
		const token = `ghp_${'a'.repeat(36)}`;
		writeManagedArchiveConfig(target);
		mockSuccessfulCloneAndDateOperations(undefined, {
			cloneFailure: (_cloneUrl, stagingPath) => {
				attempts.push(stagingPath);
				return attempts.length === 1
					? new Error('fatal: connection was reset')
					: new Error(
							`fatal: Authentication failed for https://${token}@github.com/example/new-repo.git`
						);
			},
		});
		try {
			const result = await processRepository(
				{
					clone_url: 'https://github.com/example/new-repo.git',
					defaultBranch: 'main',
					folderName: 'new-repo--example',
					id: 321,
					name: 'new-repo',
					slug: 'example/new-repo',
				},
				target,
				() => false,
				{ archiveOwnerId: 7 }
			);

			expect(result.outcome).toBe('failed');
			expect(result.message).not.toContain(token);
			expect(result.message).toContain('https://github.com/example/new-repo.git');
			expect(result.message).toContain('Git Credential Manager');
			expect(attempts).toHaveLength(2);
			expect(new Set(attempts).size).toBe(2);
			expect(attempts.every((stagingPath) => !existsSync(stagingPath))).toBe(true);
			expect(existsSync(path.join(target, 'new-repo--example'))).toBe(false);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('processRepository normalizes origin before recording a renamed repository slug', async () => {
		const { processRepository } = await import('../src/lib/refresh.ts');
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-refresh-rename-'));
		const checkout = createCheckout(target, 'original--old-owner');
		mockManagedCheckoutIdentity('original--old-owner', 101, 'old-owner/original');

		try {
			const result = await processRepository(
				{
					clone_url: 'https://github.com/new-owner/renamed-repo.git',
					defaultBranch: 'main',
					folderName: 'original--old-owner',
					id: 101,
					name: 'renamed-repo',
					pendingRename: true,
					slug: 'new-owner/renamed-repo',
				},
				target,
				() => false,
				{ archiveOwnerId: 7 }
			);

			expect(result).toEqual(
				expect.objectContaining({
					name: 'original--old-owner',
					pendingRename: true,
				})
			);
			expect(mockExecFile).toHaveBeenCalledWith(
				'git',
				['remote', 'set-url', 'origin', 'https://github.com/new-owner/renamed-repo.git'],
				expect.objectContaining({ cwd: checkout }),
				expect.any(Function)
			);
			expect(mockExecFile).toHaveBeenCalledWith(
				'git',
				['config', '--local', 'starsync.repository-slug', 'new-owner/renamed-repo'],
				expect.objectContaining({ cwd: checkout }),
				expect.any(Function)
			);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('runSyncPool processes repos with concurrency 1 sequentially', async () => {
		const mod = await import('../src/lib/refresh.ts');
		const runSyncPool = mod.runSyncPool;
		const repos: { clone_url: string; defaultBranch: string; name: string }[] = [
			{ clone_url: 'https://github.com/a/r1.git', defaultBranch: 'main', name: 'r1' },
			{ clone_url: 'https://github.com/a/r2.git', defaultBranch: 'main', name: 'r2' },
			{ clone_url: 'https://github.com/a/r3.git', defaultBranch: 'main', name: 'r3' },
		];
		const order: string[] = [];
		const results = await runSyncPool(
			repos,
			async (repo: { clone_url: string; defaultBranch: string; name: string }) => {
				order.push(repo.name);
				return { name: repo.name, outcome: 'added' as const };
			},
			{ concurrency: 1, totalCount: repos.length }
		);
		expect(results.results).toHaveLength(3);
		expect(results.interrupted).toBe(false);
		expect(order).toEqual(['r1', 'r2', 'r3']);
	});

	test('runSyncPool handles empty repo list', async () => {
		const mod = await import('../src/lib/refresh.ts');
		const runSyncPool = mod.runSyncPool;
		const results = await runSyncPool(
			[],
			async (repo: { clone_url: string; defaultBranch: string; name: string }) => ({
				name: repo.name,
				outcome: 'added' as const,
			}),
			{ concurrency: 4, totalCount: 0 }
		);
		expect(results.results).toHaveLength(0);
		expect(results.interrupted).toBe(false);
	});

	test('runSyncPool prints Syncing N/Total progress', async () => {
		const mod = await import('../src/lib/refresh.ts');
		const runSyncPool = mod.runSyncPool;
		const repos: { clone_url: string; defaultBranch: string; name: string }[] = [
			{ clone_url: 'https://github.com/a/r1.git', defaultBranch: 'main', name: 'r1' },
			{ clone_url: 'https://github.com/a/r2.git', defaultBranch: 'main', name: 'r2' },
		];
		const logs: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.join(' '));
		};
		try {
			await runSyncPool(
				repos,
				async (repo: { clone_url: string; defaultBranch: string; name: string }) => ({
					name: repo.name,
					outcome: 'added' as const,
				}),
				{ concurrency: 1, totalCount: 2 }
			);
		} finally {
			console.log = originalLog;
		}
		expect(logs.some((l) => l.includes('Syncing 1/2'))).toBe(true);
		expect(logs.some((l) => l.includes('Syncing 2/2'))).toBe(true);
		expect(logs.some((l) => l.includes('Completed 1/2'))).toBe(true);
		expect(logs.some((l) => l.includes('Completed 2/2'))).toBe(true);
	});

	test('runSyncPool reports a heartbeat while repository work is still active', async () => {
		const { runSyncPool } = await import('../src/lib/refresh.ts');
		const logs: string[] = [];
		let finish: (() => void) | undefined;
		const work = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const operation = runSyncPool(
			[
				{
					clone_url: 'https://github.com/a/slow.git',
					defaultBranch: 'main',
					name: 'slow',
				},
			],
			async (repo: { clone_url: string; defaultBranch: string; name: string }) => {
				await work;
				return { name: repo.name, outcome: 'current' as const };
			},
			{
				concurrency: 1,
				heartbeatIntervalMs: 10,
				onProgress: (message) => logs.push(message),
				totalCount: 1,
			}
		);
		try {
			await new Promise((resolve) => setTimeout(resolve, 35));
			expect(logs.some((line) => line.includes('Still working — 0/1 complete'))).toBe(true);
			expect(logs.some((line) => line.includes('slow ('))).toBe(true);
		} finally {
			finish?.();
		}
		await operation;
		expect(logs.some((line) => line.includes('Completed 1/1 — slow: current'))).toBe(true);
	});

	test('processRepository returns skipped when interruption is requested', async () => {
		const { processRepository } = await import('../src/lib/refresh.ts');
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-intr-'));
		try {
			mkdirSync(path.join(root, 'existing-repo'));
			mkdirSync(path.join(root, 'existing-repo', '.git'));

			const result = await processRepository(
				{
					clone_url: 'https://github.com/example/existing-repo.git',
					defaultBranch: 'main',
					name: 'existing-repo',
				},
				root,
				() => true,
				{ archiveOwnerId: 7 }
			);
			expect(result.outcome).toBe('skipped');
			expect(result.name).toBe('existing-repo');
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('runSyncPool passes isInterruptionRequested callback to processFn', async () => {
		const mod = await import('../src/lib/refresh.ts');
		const runSyncPool = mod.runSyncPool;
		const repos: { clone_url: string; defaultBranch: string; name: string }[] = [
			{ clone_url: 'https://github.com/a/r1.git', defaultBranch: 'main', name: 'r1' },
		];
		let callbackReceived: (() => boolean) | null = null;
		await runSyncPool(
			repos,
			async (
				_repo: { clone_url: string; defaultBranch: string; name: string },
				isInterruptionRequested: () => boolean
			) => {
				callbackReceived = isInterruptionRequested;
				return { name: 'r1', outcome: 'added' as const };
			},
			{ concurrency: 1, totalCount: 1 }
		);
		expect(callbackReceived).not.toBeNull();
		expect(callbackReceived!()).toBe(false);
	});
});

describe('structured command reporting', () => {
	test('report summaries keep lifecycle, outcome, pending rename, and severity separate', () => {
		const report = createCommandReport({
			checkouts: [
				{
					findings: [createFinding('info', 'checkout-current', 'Checkout is current.')],
					lifecycle: 'active',
					name: 'current-repo',
					outcome: 'current',
					pendingRename: false,
				},
				{
					findings: [
						createFinding('info', 'checkout-retained', 'Checkout was retained.'),
					],
					lifecycle: 'retained',
					name: 'retained-repo',
					outcome: 'skipped',
					pendingRename: false,
				},
				{
					findings: [createFinding('error', 'checkout-blocked', 'Checkout is blocked.')],
					lifecycle: 'blocked',
					name: 'blocked-repo',
					outcome: 'failed',
					pendingRename: false,
				},
				{
					findings: [createFinding('warning', 'pending-rename', 'Rename is pending.')],
					lifecycle: 'active',
					name: 'renamed-repo',
					outcome: 'skipped',
					pendingRename: true,
				},
			],
			command: 'verify',
			exitCode: 1,
			targetPath: 'C:/archive',
		});

		expect(report.summary.checkouts).toEqual({
			active: 2,
			blocked: 1,
			pendingRename: 1,
			retained: 1,
		});
		expect(report.summary.outcomes).toEqual({
			added: 0,
			current: 1,
			failed: 1,
			skipped: 2,
			updated: 0,
		});
		expect(report.summary.findings).toEqual({ error: 1, info: 2, warning: 1 });
	});

	test('parseArgs accepts --json without changing other defaults', () => {
		expect(parseArgs(['--json'])).toEqual({
			concurrency: 4,
			dryRun: false,
			help: false,
			json: true,
			targetPath: null,
		});
	});

	test('every subcommand emits exactly one JSON help document on stdout', async () => {
		const {
			dispatchDates,
			dispatchInit,
			dispatchRename,
			dispatchSync,
			dispatchUnlock,
			dispatchVerify,
		} = await import('../src/lib/subcommands.ts');
		const commands: [CommandReport['command'], () => number | Promise<number>][] = [
			['dates', () => dispatchDates(['--json', '--help'])],
			['init', () => dispatchInit(['--json', '--help'])],
			['rename', () => dispatchRename(['--json', '--help'])],
			['sync', () => dispatchSync(['--json', '--help'])],
			['unlock', () => dispatchUnlock(['--json', '--help'])],
			['verify', () => dispatchVerify(['--json', '--help'])],
		];

		for (const [command, dispatch] of commands) {
			const captured = await captureConsole(dispatch);
			expect(captured.result).toBe(0);
			expect(captured.stdout).toHaveLength(1);
			const report = parseReport(captured.stdout);
			expect(report.schemaVersion).toBe(2);
			expect(report.command).toBe(command);
			expect(report.exitCode).toBe(0);
		}
	});

	test('JSON usage errors remain one document and exit 2', async () => {
		const { dispatchVerify } = await import('../src/lib/subcommands.ts');
		const captured = await captureConsole(() => dispatchVerify(['--json', '--bogus']));
		const report = parseReport(captured.stdout);

		expect(captured.result).toBe(2);
		expect(captured.stdout).toHaveLength(1);
		expect(report.exitCode).toBe(2);
		expect(report.summary.findings.error).toBe(1);
		expect(captured.stderr.some((line) => line.includes('invalid-usage'))).toBe(true);
	});

	test('unlock emits one JSON result when the archive has no lock', async () => {
		const { dispatchUnlock } = await import('../src/lib/subcommands.ts');
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-unlock-json-'));
		try {
			const captured = await captureConsole(() => dispatchUnlock(['--json', target]));
			const report = parseReport(captured.stdout);

			expect(captured.result).toBe(0);
			expect(captured.stdout).toHaveLength(1);
			expect(report.exitCode).toBe(0);
			expect(report.findings.at(-1)?.code).toBe('archive-not-locked');
			expect(report.summary.findings.info).toBe(1);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('dates JSON keeps progress on stderr and reports planned updates', async () => {
		const { dispatchDates } = await import('../src/lib/subcommands.ts');
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-dates-json-'));
		try {
			writeManagedArchiveConfig(target);
			mkdirSync(path.join(target, 'repo-a--example', '.git'), { recursive: true });
			mockManagedCheckoutIdentity('repo-a--example', 101, 'example/repo-a');

			const captured = await captureConsole(() =>
				dispatchDates(['--json', '--dry-run', target])
			);
			const report = parseReport(captured.stdout);

			expect(captured.result).toBe(0);
			expect(captured.stdout).toHaveLength(1);
			expect(captured.stderr.some((line) => line.startsWith('Root:'))).toBe(true);
			expect(report.dryRun).toBe(true);
			expect(report.checkouts[0]).toEqual(
				expect.objectContaining({
					lifecycle: 'active',
					outcome: 'skipped',
					pendingRename: false,
					plannedOutcome: 'updated',
				})
			);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('dates human output retains oldest and newest timestamp tables', async () => {
		const { dispatchDates } = await import('../src/lib/subcommands.ts');
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-dates-human-'));
		try {
			writeManagedArchiveConfig(target);
			mkdirSync(path.join(target, 'repo-a--example', '.git'), { recursive: true });
			mockManagedCheckoutIdentity('repo-a--example', 101, 'example/repo-a');

			const captured = await captureConsole(() => dispatchDates(['--dry-run', target]));

			expect(captured.result).toBe(0);
			expect(captured.stdout).toContain('Oldest folder timestamps:');
			expect(captured.stdout).toContain('Newest folder timestamps:');
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('sync JSON reports active lifecycle and added run outcome without persistence', async () => {
		const savedToken = process.env.GITHUB_TOKEN;
		process.env.GITHUB_TOKEN = 'test-token';
		mockPaginate.mockResolvedValue([mockStarredRepository('repo-a', 101)]);
		mockSuccessfulCloneAndDateOperations();
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-json-'));
		try {
			writeManagedArchiveConfig(target);
			const captured = await captureConsole(() =>
				dispatchSync(['--json', '--concurrency=1', target])
			);
			const report = parseReport(captured.stdout);

			expect(captured.result).toBe(0);
			expect(captured.stdout).toHaveLength(1);
			expect(captured.stderr.some((line) => line.includes('Syncing 1/1'))).toBe(true);
			expect(report.schemaVersion).toBe(2);
			expect(report.checkouts[0]).toEqual(
				expect.objectContaining({
					lifecycle: 'active',
					outcome: 'added',
					pendingRename: false,
				})
			);
			expect(report.summary.outcomes.added).toBe(1);
			expect(readdirSync(target).sort()).toEqual(['.starsync', 'repo-a--example']);
		} finally {
			if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = savedToken;
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('sync human output preserves succeeded and lifecycle summaries', async () => {
		const savedToken = process.env.GITHUB_TOKEN;
		process.env.GITHUB_TOKEN = 'test-token';
		mockPaginate.mockResolvedValue([mockStarredRepository('repo-a', 101)]);
		mockSuccessfulCloneAndDateOperations();
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-human-'));
		try {
			writeManagedArchiveConfig(target);
			const captured = await captureConsole(() => dispatchSync(['--concurrency=1', target]));

			expect(captured.result).toBe(0);
			expect(captured.stdout).toContain(
				'Checkout lifecycle. Active: 1. Retained: 0. Blocked: 0. Pending rename: 0.'
			);
			expect(captured.stdout).toContain('Completed 1/1 — repo-a--example: added');
			expect(captured.stdout.some((line) => line.startsWith('- repo-a--example:'))).toBe(
				false
			);
			expect(captured.stdout).toContain('Succeeded: 1. Failed: 0.');
		} finally {
			if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = savedToken;
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('quoted-empty TARGET_PATH is rejected as a missing target', async () => {
		const savedTarget = process.env.TARGET_PATH;
		const savedToken = process.env.GITHUB_TOKEN;
		process.env.GITHUB_TOKEN = 'test-token';
		process.env.TARGET_PATH = '""';
		mockPaginate.mockResolvedValue([]);
		try {
			const captured = await captureConsole(() => dispatchSync(['--json', '--dry-run']));
			const report = parseReport(captured.stdout);

			expect(captured.result).toBe(2);
			expect(report.findings).toContainEqual(
				expect.objectContaining({ code: 'invalid-usage', severity: 'error' })
			);
		} finally {
			if (savedTarget === undefined) delete process.env.TARGET_PATH;
			else process.env.TARGET_PATH = savedTarget;
			if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = savedToken;
		}
	});

	test('blocked refreshes separate lifecycle from outcome and exit 1', async () => {
		const savedToken = process.env.GITHUB_TOKEN;
		process.env.GITHUB_TOKEN = 'test-token';
		mockPaginate.mockResolvedValue([mockStarredRepository('repo-a', 101)]);
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-blocked-json-'));
		try {
			writeManagedArchiveConfig(target);
			mkdirSync(path.join(target, 'repo-a--example', '.git'), { recursive: true });
			mockManagedCheckoutIdentity(
				'repo-a--example',
				101,
				'example/repo-a',
				' M local-file\n'
			);
			const captured = await captureConsole(() =>
				dispatchSync(['--json', '--concurrency=1', target])
			);
			const report = parseReport(captured.stdout);

			expect(captured.result).toBe(1);
			expect(captured.stdout).toHaveLength(1);
			expect(report.checkouts[0]).toEqual(
				expect.objectContaining({ lifecycle: 'blocked', outcome: 'failed' })
			);
			expect(report.checkouts[0]?.findings[0]?.severity).toBe('error');
			expect(report.summary.checkouts.blocked).toBe(1);
			expect(report.summary.outcomes.failed).toBe(1);
		} finally {
			if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = savedToken;
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('first interruption emits partial JSON and exits 130', async () => {
		const controller = new AbortController();
		mockPaginate.mockResolvedValue([
			mockStarredRepository('repo-a', 101),
			mockStarredRepository('repo-b', 102),
		]);
		mockSuccessfulCloneAndDateOperations(undefined, {
			afterClone: (cloneUrl) => {
				if (cloneUrl.includes('repo-a')) {
					controller.abort();
				}
			},
		});
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-interrupted-json-'));
		try {
			writeManagedArchiveConfig(target);
			const captured = await captureConsole(async () => {
				const report = await syncArchive({
					concurrency: 1,
					signal: controller.signal,
					targetPath: target,
					token: 'test-token',
				});
				createCommandReporter(true).emit(report);
				return report.exitCode;
			});
			const report = parseReport(captured.stdout);

			expect(captured.result).toBe(130);
			expect(captured.stdout).toHaveLength(1);
			expect(report.interrupted).toBe(true);
			expect(report.exitCode).toBe(130);
			expect(report.summary.outcomes.added).toBe(1);
			expect(report.summary.outcomes.skipped).toBe(1);
			expect(report.findings.some((finding) => finding.code === 'interrupted')).toBe(true);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});
});
