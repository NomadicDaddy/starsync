import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { listFolders, parseArgs, resolveTargetPath, stripQuotes } from '../src/index.ts';

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
