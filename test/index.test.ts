import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	cloneOrPull,
	listFolders,
	parseArgs,
	resolveTargetPath,
	runStarsync,
	stripQuotes,
} from '../src/index.ts';
import type { Repository, SyncResult } from '../src/index.ts';

const mockExecFileSync = mock((_cmd: string, _args: string[]): string | undefined => undefined);

mock.module('node:child_process', () => ({
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

afterEach(() => {
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
		expect(mockExecFileSync).toHaveBeenCalledWith('git', ['clone', repo.clone_url], {
			cwd: '/tmp/target',
			stdio: 'inherit',
		});
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
			expect(mockExecFileSync).toHaveBeenCalledWith('git', ['clone', repo.clone_url], {
				cwd: root,
				stdio: 'inherit',
			});
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
			expect(mockExecFileSync).toHaveBeenNthCalledWith(2, 'git', ['pull'], {
				cwd: path.join(root, 'test-repo'),
				stdio: 'inherit',
			});
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
			expect(mockExecFileSync).toHaveBeenNthCalledWith(2, 'git', ['pull'], {
				cwd: path.join(root, 'test-repo'),
				stdio: 'inherit',
			});
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
			expect(mockExecFileSync).toHaveBeenNthCalledWith(2, 'git', ['pull'], {
				cwd: path.join(root, 'test-repo'),
				stdio: 'inherit',
			});
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
		expect(parseArgs([])).toEqual({ dryRun: false, help: false, targetPath: null });
		expect(parseArgs(['--help'])).toEqual({ dryRun: false, help: true, targetPath: null });
		expect(parseArgs(['-h'])).toEqual({ dryRun: false, help: true, targetPath: null });
		expect(parseArgs(['repos'])).toEqual({ dryRun: false, help: false, targetPath: 'repos' });
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
			mockExecFileSync.mockReturnValue(undefined);

			const target = mkdtempSync(path.join(tmpdir(), 'starsync-sync-'));
			try {
				const exitCode = await runStarsync([target]);
				expect(exitCode).toBe(0);
				expect(mockExecFileSync).toHaveBeenCalledTimes(2);
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
			// First clone succeeds, second clone throws
			mockExecFileSync.mockReturnValueOnce(undefined).mockImplementationOnce(() => {
				throw new Error('fatal: repository not found');
			});

			const target = mkdtempSync(path.join(tmpdir(), 'starsync-sync-'));
			try {
				const exitCode = await runStarsync([target]);
				expect(exitCode).toBe(1);
				expect(mockExecFileSync).toHaveBeenCalledTimes(2);
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

	test(
		'queries stars and reports would-clone without calling git',
		async () => {
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
		}
	);

	test(
		'reports would-pull for existing repos without calling git pull',
		async () => {
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
		}
	);
});

describe('parseArgs --dry-run', () => {
	test('accepts --dry-run flag', () => {
		expect(parseArgs(['--dry-run'])).toEqual({
			dryRun: true,
			help: false,
			targetPath: null,
		});
		expect(parseArgs(['--dry-run', 'repos'])).toEqual({
			dryRun: true,
			help: false,
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
