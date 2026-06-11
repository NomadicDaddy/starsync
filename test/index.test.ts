import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { cloneOrPull, listFolders, parseArgs, resolveTargetPath, stripQuotes } from '../src/index.ts';
import type { Repository, SyncResult } from '../src/index.ts';

const mockExecFileSync = mock((_cmd: string, _args: string[]) => {});

mock.module('node:child_process', () => ({
	execFileSync: mockExecFileSync,
}));

afterEach(() => {
	mockExecFileSync.mockReset();
});

describe('cloneOrPull', () => {
	const repo: Repository = { clone_url: 'https://github.com/example/test-repo.git', name: 'test-repo' };

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
				expect(result.failure.message).toContain('https://github.com/other-user/test-repo.git');
				expect(result.failure.message).toContain('https://github.com/example/test-repo.git');
			}
			// Should only have called execFileSync once (the remote URL check), not git pull
			expect(mockExecFileSync).toHaveBeenCalledTimes(1);
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
		expect(parseArgs([])).toEqual({ help: false, targetPath: null });
		expect(parseArgs(['--help'])).toEqual({ help: true, targetPath: null });
		expect(parseArgs(['-h'])).toEqual({ help: true, targetPath: null });
		expect(parseArgs(['repos'])).toEqual({ help: false, targetPath: 'repos' });
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
