import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import fs, { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { sameFilesystemEntry } from '../src/lib/filesystem-identity.ts';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const directory = (): string => {
	const root = mkdtempSync(path.join(tmpdir(), 'starsync-identity-'));
	roots.push(root);
	const target = path.join(root, 'entry');
	mkdirSync(target);
	return target;
};

describe('filesystem identity', () => {
	test('matches an entry with itself and not with a sibling', () => {
		const entry = directory();
		const sibling = path.join(path.dirname(entry), 'sibling');
		mkdirSync(sibling);
		expect(sameFilesystemEntry(entry, entry)).toBe(true);
		expect(sameFilesystemEntry(entry, sibling)).toBe(false);
	});

	// Some network shares, and some filesystems, report no file index. Two such entries on one
	// volume would otherwise compare equal, so a zero index can't establish identity.
	test('refuses an entry the filesystem reports a zero file index for', () => {
		const entry = directory();
		const realStat = fs.statSync.bind(fs);
		const stat = spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, options) => {
			const stats = realStat(target, options) as fs.BigIntStats;
			return Object.assign(Object.create(Object.getPrototypeOf(stats) as object), stats, {
				ino: 0n,
			}) as fs.BigIntStats;
		}) as typeof fs.statSync);
		try {
			expect(sameFilesystemEntry(entry, entry)).toBe(false);
		} finally {
			stat.mockRestore();
		}
		expect(sameFilesystemEntry(entry, entry)).toBe(true);
	});

	test('refuses a path it cannot read', () => {
		const entry = directory();
		const stat = spyOn(fs, 'statSync').mockImplementation((() => {
			throw Object.assign(new Error('Access denied.'), { code: 'EACCES' });
		}) as typeof fs.statSync);
		try {
			expect(sameFilesystemEntry(entry, entry)).toBe(false);
		} finally {
			stat.mockRestore();
		}
	});

	// ReFS's 64-bit index isn't guaranteed unique, so a shared index alone can't make two distinct
	// directories one entry: their canonical paths must agree too.
	test('refuses two directories that report the same file index', () => {
		const entry = directory();
		const sibling = path.join(path.dirname(entry), 'sibling');
		mkdirSync(sibling);
		const realStat = fs.statSync.bind(fs);
		const stat = spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, options) =>
			realStat(
				path.resolve(String(target)) === path.resolve(sibling) ? entry : target,
				options,
			)) as typeof fs.statSync);
		try {
			expect(sameFilesystemEntry(entry, sibling)).toBe(false);
		} finally {
			stat.mockRestore();
		}
	});

	test('matches a different spelling of the same directory', () => {
		const entry = directory();
		const respelled = path.join(path.dirname(entry), '.', 'entry');
		expect(sameFilesystemEntry(entry, respelled)).toBe(true);
	});
});
