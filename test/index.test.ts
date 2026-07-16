import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Repository, SyncResult } from '../src/index.ts';
import type { CommandReport } from '../src/lib/reporting.ts';

import {
	cloneOrPull,
	listFolders,
	parseArgs,
	resolveTargetPath,
	runStarsync,
	stripQuotes,
} from '../src/index.ts';
import { createCommandReport, createFinding } from '../src/lib/reporting.ts';
import {
	hasEmbeddedCredentials,
	isGitAuthError,
	isGitHubDotComUrl,
	sanitizeMessage,
	sanitizeUrl,
	extractHost,
} from '../src/lib/secret-safety.ts';

const mockExecFileSync = mock((_cmd: string, _args: string[]): string | undefined => undefined);

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

mock.module('node:child_process', () => ({
	execFile: mockExecFile,
	execFileSync: mockExecFileSync,
}));

interface MockRepoResponse {
	clone_url: string;
	name: string;
}

const mockPaginate = mock((): Promise<MockRepoResponse[]> => Promise.resolve([]));

mock.module('@octokit/rest', () => ({
	Octokit: class MockOctokit {
		rest = {
			activity: {
				listReposStarredByAuthenticatedUser: {},
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

afterEach(() => {
	mockExecFile.mockClear();
	mockExecFileSync.mockReset();
	mockPaginate.mockReset();
});

describe('cloneOrPull', () => {
	const repo: Repository = {
		clone_url: 'https://github.com/example/test-repo.git',
		name: 'test-repo',
	};

	test('clones a new repository when folder does not exist', () => {
		mockExecFileSync.mockReturnValue(undefined);
		const result: SyncResult = cloneOrPull(repo, '/tmp/target', new Set());

		expect(result.ok).toBe(true);
		expect(mockExecFileSync).toHaveBeenCalledTimes(1);
		expect(mockExecFileSync).toHaveBeenCalledWith(
			'git',
			['-c', 'core.askPass=', 'clone', repo.clone_url],
			expect.objectContaining({ cwd: '/tmp/target', stdio: 'inherit' })
		);
	});

	test('clones a repository when folder exists but lacks .git directory', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-test-'));
		try {
			mkdirSync(path.join(root, 'test-repo'));
			mockExecFileSync.mockReturnValue(undefined);

			const existing = new Set(['test-repo']);
			const result: SyncResult = cloneOrPull(repo, root, existing);

			expect(result.ok).toBe(true);
			expect(mockExecFileSync).toHaveBeenCalledTimes(1);
			expect(mockExecFileSync).toHaveBeenCalledWith(
				'git',
				['-c', 'core.askPass=', 'clone', repo.clone_url],
				expect.objectContaining({ cwd: root, stdio: 'inherit' })
			);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('pulls an existing repository when folder has .git directory and remote URL matches', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-test-'));
		try {
			mkdirSync(path.join(root, 'test-repo'));
			mkdirSync(path.join(root, 'test-repo', '.git'));

			const existing = new Set(['test-repo']);
			// First call: remote URL check; second call: git pull
			mockExecFileSync
				.mockReturnValueOnce('https://github.com/example/test-repo.git\n')
				.mockReturnValueOnce(undefined);

			const result: SyncResult = cloneOrPull(repo, root, existing);

			expect(result.ok).toBe(true);
			expect(mockExecFileSync).toHaveBeenCalledTimes(2);
			expect(mockExecFileSync).toHaveBeenNthCalledWith(
				1,
				'git',
				['-C', path.join(root, 'test-repo'), 'config', '--get', 'remote.origin.url'],
				{ encoding: 'utf-8' }
			);
			expect(mockExecFileSync).toHaveBeenNthCalledWith(
				2,
				'git',
				['-c', 'core.askPass=', 'pull'],
				expect.objectContaining({ cwd: path.join(root, 'test-repo'), stdio: 'inherit' })
			);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('returns failure when remote URL does not match the expected clone URL', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-test-'));
		try {
			mkdirSync(path.join(root, 'test-repo'));
			mkdirSync(path.join(root, 'test-repo', '.git'));

			const otherRepo: Repository = {
				clone_url: 'https://github.com/other-user/test-repo.git',
				name: 'test-repo',
			};
			mockExecFileSync.mockReturnValueOnce('https://github.com/example/test-repo.git\n');

			const existing = new Set(['test-repo']);
			const result: SyncResult = cloneOrPull(otherRepo, root, existing);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.failure.verb).toBe('clone');
				expect(result.failure.name).toBe('test-repo');
				expect(result.failure.message).toContain('Remote URL mismatch');
				expect(result.failure.message).toContain(
					'https://github.com/other-user/test-repo.git'
				);
				expect(result.failure.message).toContain(
					'https://github.com/example/test-repo.git'
				);
			}
			// Should only have called execFileSync once (the remote URL check), not git pull
			expect(mockExecFileSync).toHaveBeenCalledTimes(1);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('pulls when folder with .git exists on disk but its name is missing from the existing set', () => {
		// Simulates a case-insensitive filesystem (Windows) where the folder is e.g.
		// 'Test-Repo' but the GitHub repo name is 'test-repo' — the Set lookup misses,
		// but the filesystem check must still detect the existing clone.
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-test-'));
		try {
			mkdirSync(path.join(root, 'test-repo'));
			mkdirSync(path.join(root, 'test-repo', '.git'));

			mockExecFileSync
				.mockReturnValueOnce('https://github.com/example/test-repo.git\n')
				.mockReturnValueOnce(undefined);

			const result: SyncResult = cloneOrPull(repo, root, new Set());

			expect(result.ok).toBe(true);
			expect(mockExecFileSync).toHaveBeenCalledTimes(2);
			expect(mockExecFileSync).toHaveBeenNthCalledWith(
				2,
				'git',
				['-c', 'core.askPass=', 'pull'],
				expect.objectContaining({ cwd: path.join(root, 'test-repo'), stdio: 'inherit' })
			);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('pulls when remote URL differs only by owner casing', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-test-'));
		try {
			mkdirSync(path.join(root, 'test-repo'));
			mkdirSync(path.join(root, 'test-repo', '.git'));

			// GitHub owner names are case-insensitive: Example vs example is the same repo
			mockExecFileSync
				.mockReturnValueOnce('https://github.com/Example/test-repo.git\n')
				.mockReturnValueOnce(undefined);

			const existing = new Set(['test-repo']);
			const result: SyncResult = cloneOrPull(repo, root, existing);

			expect(result.ok).toBe(true);
			expect(mockExecFileSync).toHaveBeenCalledTimes(2);
			expect(mockExecFileSync).toHaveBeenNthCalledWith(
				2,
				'git',
				['-c', 'core.askPass=', 'pull'],
				expect.objectContaining({ cwd: path.join(root, 'test-repo'), stdio: 'inherit' })
			);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('pulls when remote URL differs only by a missing .git suffix', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-test-'));
		try {
			mkdirSync(path.join(root, 'test-repo'));
			mkdirSync(path.join(root, 'test-repo', '.git'));

			mockExecFileSync
				.mockReturnValueOnce('https://github.com/example/test-repo\n')
				.mockReturnValueOnce(undefined);

			const existing = new Set(['test-repo']);
			const result: SyncResult = cloneOrPull(repo, root, existing);

			expect(result.ok).toBe(true);
			expect(mockExecFileSync).toHaveBeenCalledTimes(2);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('returns failure when clone throws an error', () => {
		mockExecFileSync.mockImplementation(() => {
			throw new Error('fatal: repository not found');
		});

		const result: SyncResult = cloneOrPull(repo, '/tmp/target', new Set());

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.failure.verb).toBe('clone');
			expect(result.failure.name).toBe('test-repo');
			expect(result.failure.message).toContain('fatal: repository not found');
		}
	});

	test('returns failure when pull throws an error', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-test-'));
		try {
			mkdirSync(path.join(root, 'test-repo'));
			mkdirSync(path.join(root, 'test-repo', '.git'));
			// First call: remote URL check succeeds; second call: git pull throws
			mockExecFileSync
				.mockReturnValueOnce('https://github.com/example/test-repo.git\n')
				.mockImplementation(() => {
					throw new Error('CONFLICT: merge conflict in file.ts');
				});

			const existing = new Set(['test-repo']);
			const result: SyncResult = cloneOrPull(repo, root, existing);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.failure.verb).toBe('pull');
				expect(result.failure.name).toBe('test-repo');
				expect(result.failure.message).toContain('CONFLICT');
			}
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});
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
		expect(resolveTargetPath('repos', '/ignored', '/base')).toBe(path.resolve('repos'));
	});

	test('uses quoted environment target when no positional target is provided', () => {
		expect(resolveTargetPath(null, '"repos from env"', '/base')).toBe(
			path.resolve('repos from env')
		);
	});

	test('falls back to starred_repos under the base directory', () => {
		expect(resolveTargetPath(null, '', '/base')).toBe(path.resolve('/base', 'starred_repos'));
	});

	test('strips surrounding quotes and whitespace', () => {
		expect(stripQuotes(' "C:/repos" ')).toBe('C:/repos');
		expect(stripQuotes("'C:/repos'")).toBe('C:/repos');
	});
});

describe('folder discovery', () => {
	test('returns only immediate folder names', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-test-'));
		try {
			mkdirSync(path.join(root, 'repo-a'));
			mkdirSync(path.join(root, 'repo-b'));
			writeFileSync(path.join(root, 'README.md'), 'not a directory');

			expect([...listFolders(root)].sort()).toEqual(['repo-a', 'repo-b']);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('returns an empty set for a missing path', () => {
		expect(listFolders(path.join(tmpdir(), 'starsync-missing-path')).size).toBe(0);
	});
});

describe('runStarsync', () => {
	let savedToken: string | undefined;

	const withToken = (fn: () => Promise<void> | void) => async () => {
		savedToken = process.env.GITHUB_TOKEN;
		process.env.GITHUB_TOKEN = 'test-token';
		try {
			await fn();
		} finally {
			if (savedToken === undefined) {
				delete process.env.GITHUB_TOKEN;
			} else {
				process.env.GITHUB_TOKEN = savedToken;
			}
		}
	};

	test('returns exit code 1 when GITHUB_TOKEN is not set', async () => {
		delete process.env.GITHUB_TOKEN;
		const exitCode = await runStarsync([]);
		expect(exitCode).toBe(1);
	});

	test(
		'returns exit code 0 for --help flag',
		withToken(async () => {
			const exitCode = await runStarsync(['--help']);
			expect(exitCode).toBe(0);
		})
	);

	test(
		'returns exit code 2 for unknown argument',
		withToken(async () => {
			const exitCode = await runStarsync(['--unknown']);
			expect(exitCode).toBe(2);
		})
	);

	test(
		'returns exit code 0 on successful sync with two repos',
		withToken(async () => {
			mockPaginate.mockResolvedValue([
				{ clone_url: 'https://github.com/example/repo-a.git', name: 'repo-a' },
				{ clone_url: 'https://github.com/example/repo-b.git', name: 'repo-b' },
			]);
			mockExecFile.mockImplementation(
				(
					_cmd: string,
					_args: string[],
					_options: unknown,
					callback: (err: Error | null, stdout: string, stderr: string) => void
				): void => {
					callback(null, '', '');
				}
			);

			const target = mkdtempSync(path.join(tmpdir(), 'starsync-sync-'));
			try {
				const exitCode = await runStarsync([target]);
				expect(exitCode).toBe(0);
			} finally {
				rmSync(target, { force: true, recursive: true });
			}
		})
	);

	test(
		'returns exit code 1 when one clone fails (partial failure)',
		withToken(async () => {
			mockPaginate.mockResolvedValue([
				{ clone_url: 'https://github.com/example/repo-a.git', name: 'repo-a' },
				{ clone_url: 'https://github.com/example/repo-b.git', name: 'repo-b' },
			]);
			// repo-a succeeds, repo-b fails
			mockExecFile.mockImplementation(
				(
					_cmd: string,
					args: string[],
					_options: unknown,
					callback: (err: Error | null, stdout: string, stderr: string) => void
				): void => {
					if (args.includes('repo-b')) {
						callback(new Error('fatal: repository not found'), '', '');
					} else {
						callback(null, '', '');
					}
				}
			);

			const target = mkdtempSync(path.join(tmpdir(), 'starsync-sync-'));
			try {
				const exitCode = await runStarsync([target]);
				expect(exitCode).toBe(1);
			} finally {
				rmSync(target, { force: true, recursive: true });
			}
		})
	);
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
		mockPaginate.mockResolvedValue([
			{ clone_url: 'https://github.com/example/repo-a.git', name: 'repo-a' },
		]);
		mockExecFileSync.mockReturnValue(undefined);

		const target = mkdtempSync(path.join(tmpdir(), 'starsync-dryrun-'));
		try {
			const exitCode = await runStarsync([target, '--dry-run']);
			expect(exitCode).toBe(0);
			// In dry-run mode, no git clone/pull should be called
			expect(mockExecFileSync).not.toHaveBeenCalled();
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('reports would-pull for existing repos without calling git pull', async () => {
		savedToken = process.env.GITHUB_TOKEN;
		process.env.GITHUB_TOKEN = 'test-token';
		mockPaginate.mockResolvedValue([
			{ clone_url: 'https://github.com/example/repo-a.git', name: 'repo-a' },
		]);

		const target = mkdtempSync(path.join(tmpdir(), 'starsync-dryrun-'));
		try {
			mkdirSync(path.join(target, 'repo-a'));
			mkdirSync(path.join(target, 'repo-a', '.git'));

			const exitCode = await runStarsync([target, '--dry-run']);
			expect(exitCode).toBe(0);
			// In dry-run mode, no git operations at all
			expect(mockExecFileSync).not.toHaveBeenCalled();
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
		expect(isSubcommand('migrate')).toBe(true);
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

	test('dispatchVerify exits 1 with not-available message', async () => {
		const { dispatchVerify } = await import('../src/lib/subcommands.ts');
		const exitCode = dispatchVerify([]);
		expect(exitCode).toBe(1);
	});

	test('dispatchVerify --help exits 0', async () => {
		const { dispatchVerify } = await import('../src/lib/subcommands.ts');
		const exitCode = dispatchVerify(['--help']);
		expect(exitCode).toBe(0);
	});

	test('dispatchVerify rejects unknown flags with exit 2', async () => {
		const { dispatchVerify } = await import('../src/lib/subcommands.ts');
		const exitCode = dispatchVerify(['--bogus']);
		expect(exitCode).toBe(2);
	});

	test('dispatchMigrate exits 1 with not-available message', async () => {
		const { dispatchMigrate } = await import('../src/lib/subcommands.ts');
		const exitCode = dispatchMigrate([]);
		expect(exitCode).toBe(1);
	});

	test('dispatchMigrate --apply exits 1 with not-available message', async () => {
		const { dispatchMigrate } = await import('../src/lib/subcommands.ts');
		const exitCode = dispatchMigrate(['--apply']);
		expect(exitCode).toBe(1);
	});

	test('dispatchMigrate --help exits 0', async () => {
		const { dispatchMigrate } = await import('../src/lib/subcommands.ts');
		const exitCode = dispatchMigrate(['--help']);
		expect(exitCode).toBe(0);
	});

	test('dispatchInit exits 1 with not-available message', async () => {
		const { dispatchInit } = await import('../src/lib/subcommands.ts');
		const exitCode = dispatchInit([]);
		expect(exitCode).toBe(1);
	});

	test('dispatchInit --help exits 0', async () => {
		const { dispatchInit } = await import('../src/lib/subcommands.ts');
		const exitCode = dispatchInit(['--help']);
		expect(exitCode).toBe(0);
	});

	test('dispatchUnlock exits 1 with not-available message', async () => {
		const { dispatchUnlock } = await import('../src/lib/subcommands.ts');
		const exitCode = dispatchUnlock([]);
		expect(exitCode).toBe(1);
	});

	test('dispatchUnlock --help exits 0', async () => {
		const { dispatchUnlock } = await import('../src/lib/subcommands.ts');
		const exitCode = dispatchUnlock(['--help']);
		expect(exitCode).toBe(0);
	});

	test('dispatchDates exits 1 for nonexistent target path', async () => {
		const { dispatchDates } = await import('../src/lib/subcommands.ts');
		const exitCode = dispatchDates(['./nonexistent-test-dir-xyz']);
		expect(exitCode).toBe(1);
	});

	test('dispatchDates --help exits 0', async () => {
		const { dispatchDates } = await import('../src/lib/subcommands.ts');
		const exitCode = dispatchDates(['--help']);
		expect(exitCode).toBe(0);
	});

	test('dispatchDates processes git repos in --dry-run mode', async () => {
		const { dispatchDates } = await import('../src/lib/subcommands.ts');
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-subcmd-'));
		try {
			mkdirSync(path.join(target, 'repo-a'));
			mkdirSync(path.join(target, 'repo-a', '.git'));
			mkdirSync(path.join(target, 'repo-b'));
			mockExecFileSync.mockReturnValue('2026-07-16T10:00:00Z\n');

			const exitCode = dispatchDates([target, '--dry-run']);
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

describe('cloneOrPull secret safety integration', () => {
	const githubRepo: Repository = {
		clone_url: 'https://github.com/example/test-repo.git',
		name: 'test-repo',
	};

	test('rejects non-GitHub.com repository origins', () => {
		const gheRepo: Repository = {
			clone_url: 'https://ghe.corp.com/example/test-repo.git',
			name: 'test-repo',
		};
		const result: SyncResult = cloneOrPull(gheRepo, '/tmp/target', new Set());

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.failure.message).toContain('not GitHub.com');
			expect(result.failure.message).toContain('ghe.corp.com');
		}
		expect(mockExecFileSync).not.toHaveBeenCalled();
	});

	test('rejects GitLab repository origins', () => {
		const gitlabRepo: Repository = {
			clone_url: 'https://gitlab.com/example/test-repo.git',
			name: 'test-repo',
		};
		const result: SyncResult = cloneOrPull(gitlabRepo, '/tmp/target', new Set());

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.failure.message).toContain('not GitHub.com');
		}
	});

	test('sanitizes embedded credentials from remote URL mismatch messages', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-test-'));
		try {
			mkdirSync(path.join(root, 'test-repo'));
			mkdirSync(path.join(root, 'test-repo', '.git'));

			// Remote URL contains embedded credentials
			mockExecFileSync.mockReturnValueOnce(
				'https://user:secret@github.com/example/test-repo.git\n'
			);

			const result: SyncResult = cloneOrPull(
				{
					clone_url: 'https://github.com/other/test-repo.git',
					name: 'test-repo',
				},
				root,
				new Set(['test-repo'])
			);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.failure.message).not.toContain('user:secret');
				expect(result.failure.message).toContain(
					'https://github.com/example/test-repo.git'
				);
			}
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('appends credential guidance on Git auth errors', () => {
		mockExecFileSync.mockImplementation(() => {
			throw new Error('fatal: Authentication failed for repository');
		});

		const result: SyncResult = cloneOrPull(githubRepo, '/tmp/target', new Set());

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.failure.message).toContain('Authentication failed');
			expect(result.failure.message).toContain('Git Credential Manager');
		}
	});

	test('does not append guidance on non-auth Git errors', () => {
		mockExecFileSync.mockImplementation(() => {
			throw new Error('fatal: repository not found');
		});

		const result: SyncResult = cloneOrPull(githubRepo, '/tmp/target', new Set());

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.failure.message).not.toContain('Git Credential Manager');
		}
	});

	test('redacts tokens in error messages from Git failures', () => {
		mockExecFileSync.mockImplementation(() => {
			throw new Error(
				"fatal: could not read Username for 'https://ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA@github.com/repo.git'"
			);
		});

		const result: SyncResult = cloneOrPull(githubRepo, '/tmp/target', new Set());

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.failure.message).not.toContain('ghp_');
			expect(result.failure.message).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
			expect(result.failure.message).toContain('https://github.com/repo.git');
		}
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
	test('processRepository clones new repo and returns added', async () => {
		const { processRepository } = (await import('../src/lib/refresh.ts')) as {
			processRepository: (
				repo: { clone_url: string; name: string },
				targetBase: string,
				isInterruptionRequested: () => boolean
			) => Promise<{ name: string; outcome: string }>;
		};
		const repo = {
			clone_url: 'https://github.com/example/new-repo.git',
			name: 'new-repo',
		};
		const result = await processRepository(repo, '/tmp/test-target', () => false);
		expect(result.outcome).toBe('added');
		expect(result.name).toBe('new-repo');
	});

	test('runSyncPool processes repos with concurrency 1 sequentially', async () => {
		const mod = await import('../src/lib/refresh.ts');
		const runSyncPool = mod.runSyncPool;
		const repos: { clone_url: string; name: string }[] = [
			{ clone_url: 'https://github.com/a/r1.git', name: 'r1' },
			{ clone_url: 'https://github.com/a/r2.git', name: 'r2' },
			{ clone_url: 'https://github.com/a/r3.git', name: 'r3' },
		];
		const order: string[] = [];
		const results = await runSyncPool(
			repos,
			async (repo: { clone_url: string; name: string }) => {
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
			async (repo: { clone_url: string; name: string }) => ({
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
		const repos: { clone_url: string; name: string }[] = [
			{ clone_url: 'https://github.com/a/r1.git', name: 'r1' },
			{ clone_url: 'https://github.com/a/r2.git', name: 'r2' },
		];
		const logs: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.join(' '));
		};
		try {
			await runSyncPool(
				repos,
				async (repo: { clone_url: string; name: string }) => ({
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
					name: 'existing-repo',
				},
				root,
				() => true
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
		const repos: { clone_url: string; name: string }[] = [
			{ clone_url: 'https://github.com/a/r1.git', name: 'r1' },
		];
		let callbackReceived: (() => boolean) | null = null;
		await runSyncPool(
			repos,
			async (
				_repo: { clone_url: string; name: string },
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
			dispatchMigrate,
			dispatchSync,
			dispatchUnlock,
			dispatchVerify,
		} = await import('../src/lib/subcommands.ts');
		const commands: [CommandReport['command'], () => number | Promise<number>][] = [
			['dates', () => dispatchDates(['--json', '--help'])],
			['init', () => dispatchInit(['--json', '--help'])],
			['migrate', () => dispatchMigrate(['--json', '--help'])],
			['sync', () => dispatchSync(['--json', '--help'])],
			['unlock', () => dispatchUnlock(['--json', '--help'])],
			['verify', () => dispatchVerify(['--json', '--help'])],
		];

		for (const [command, dispatch] of commands) {
			const captured = await captureConsole(dispatch);
			expect(captured.result).toBe(0);
			expect(captured.stdout).toHaveLength(1);
			const report = parseReport(captured.stdout);
			expect(report.schemaVersion).toBe(1);
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

	test('unavailable commands emit their JSON result before exit 1', async () => {
		const { dispatchVerify } = await import('../src/lib/subcommands.ts');
		const captured = await captureConsole(() => dispatchVerify(['--json', 'C:/archive']));
		const report = parseReport(captured.stdout);

		expect(captured.result).toBe(1);
		expect(captured.stdout).toHaveLength(1);
		expect(report.exitCode).toBe(1);
		expect(report.findings.at(-1)?.code).toBe('command-unavailable');
		expect(report.summary.findings.error).toBe(1);
	});

	test('dates JSON keeps progress on stderr and reports planned updates', async () => {
		const { dispatchDates } = await import('../src/lib/subcommands.ts');
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-dates-json-'));
		try {
			mkdirSync(path.join(target, 'repo-a', '.git'), { recursive: true });
			mockExecFileSync.mockReturnValue('2026-07-16T10:00:00Z\n');

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
			mkdirSync(path.join(target, 'repo-a', '.git'), { recursive: true });
			mockExecFileSync.mockReturnValue('2026-07-16T10:00:00Z\n');

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
		mockPaginate.mockResolvedValue([
			{ clone_url: 'https://github.com/example/repo-a.git', name: 'repo-a' },
		]);
		mockExecFile.mockImplementation(
			(
				_cmd: string,
				_args: string[],
				_options: unknown,
				callback: (err: Error | null, stdout: string, stderr: string) => void
			): void => callback(null, '', '')
		);
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-json-'));
		try {
			const captured = await captureConsole(() =>
				runStarsync(['--json', '--concurrency=1', target])
			);
			const report = parseReport(captured.stdout);

			expect(captured.result).toBe(0);
			expect(captured.stdout).toHaveLength(1);
			expect(captured.stderr.some((line) => line.includes('Syncing 1/1'))).toBe(true);
			expect(report.schemaVersion).toBe(1);
			expect(report.checkouts[0]).toEqual(
				expect.objectContaining({
					lifecycle: 'active',
					outcome: 'added',
					pendingRename: false,
				})
			);
			expect(report.summary.outcomes.added).toBe(1);
			expect(readdirSync(target)).toEqual([]);
		} finally {
			if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = savedToken;
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('sync human output preserves succeeded and lifecycle summaries', async () => {
		const savedToken = process.env.GITHUB_TOKEN;
		process.env.GITHUB_TOKEN = 'test-token';
		mockPaginate.mockResolvedValue([
			{ clone_url: 'https://github.com/example/repo-a.git', name: 'repo-a' },
		]);
		mockExecFile.mockImplementation(
			(
				_cmd: string,
				_args: string[],
				_options: unknown,
				callback: (err: Error | null, stdout: string, stderr: string) => void
			): void => callback(null, '', '')
		);
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-human-'));
		try {
			const captured = await captureConsole(() => runStarsync(['--concurrency=1', target]));

			expect(captured.result).toBe(0);
			expect(captured.stdout).toContain(
				'Checkout lifecycle. Active: 1. Retained: 0. Blocked: 0. Pending rename: 0.'
			);
			expect(captured.stdout).toContain('Succeeded: 1. Failed: 0.');
		} finally {
			if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = savedToken;
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('quoted-empty TARGET_PATH is reported as a fallback warning', async () => {
		const savedTarget = process.env.TARGET_PATH;
		const savedToken = process.env.GITHUB_TOKEN;
		process.env.GITHUB_TOKEN = 'test-token';
		process.env.TARGET_PATH = '""';
		mockPaginate.mockResolvedValue([]);
		try {
			const captured = await captureConsole(() => runStarsync(['--json', '--dry-run']));
			const report = parseReport(captured.stdout);

			expect(captured.result).toBe(0);
			expect(report.findings).toContainEqual(
				expect.objectContaining({ code: 'fallback-target', severity: 'warning' })
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
		mockPaginate.mockResolvedValue([
			{ clone_url: 'https://github.com/example/repo-a.git', name: 'repo-a' },
		]);
		mockExecFile.mockImplementation(
			(
				_cmd: string,
				args: string[],
				_options: unknown,
				callback: (err: Error | null, stdout: string, stderr: string) => void
			): void => callback(null, args.includes('status') ? ' M local-file\n' : '', '')
		);
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-blocked-json-'));
		try {
			mkdirSync(path.join(target, 'repo-a', '.git'), { recursive: true });
			const captured = await captureConsole(() =>
				runStarsync(['--json', '--concurrency=1', target])
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
		const savedToken = process.env.GITHUB_TOKEN;
		process.env.GITHUB_TOKEN = 'test-token';
		mockPaginate.mockResolvedValue([
			{ clone_url: 'https://github.com/example/repo-a.git', name: 'repo-a' },
			{ clone_url: 'https://github.com/example/repo-b.git', name: 'repo-b' },
		]);
		mockExecFile.mockImplementation(
			(
				_cmd: string,
				args: string[],
				_options: unknown,
				callback: (err: Error | null, stdout: string, stderr: string) => void
			): void => {
				if (args.includes('repo-a')) {
					const signalHandler = process.listeners('SIGINT').at(-1);
					if (signalHandler === undefined)
						throw new Error('SIGINT handler was not registered');
					signalHandler('SIGINT');
				}
				callback(null, '', '');
			}
		);
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-interrupted-json-'));
		try {
			const captured = await captureConsole(() =>
				runStarsync(['--json', '--concurrency=1', target])
			);
			const report = parseReport(captured.stdout);

			expect(captured.result).toBe(130);
			expect(captured.stdout).toHaveLength(1);
			expect(report.interrupted).toBe(true);
			expect(report.exitCode).toBe(130);
			expect(report.summary.outcomes.added).toBe(1);
			expect(report.summary.outcomes.skipped).toBe(1);
			expect(report.findings.some((finding) => finding.code === 'interrupted')).toBe(true);
		} finally {
			if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = savedToken;
			rmSync(target, { force: true, recursive: true });
		}
	});
});
