import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	addRealCommit,
	createRealRefreshFixture,
	pushRealBranch,
	runRealGit,
	runRealRefresh,
} from './helpers/refresh-fixture.ts';

// Kept outside index.test.ts so scripts/test.ts gives real subprocesses its 30-second timeout.
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
				'remote update',
			);
			expect(runRealGit(['rev-parse', 'HEAD'], fixture.checkout)).toBe(
				runRealGit(['rev-parse', 'refs/remotes/origin/main'], fixture.checkout),
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
				'renamed default',
			);
			expect(runRealGit(['rev-parse', 'HEAD'], fixture.checkout)).toBe(
				runRealGit(['rev-parse', 'refs/remotes/origin/trunk'], fixture.checkout),
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
				runRealGit(['rev-parse', 'refs/remotes/origin/main'], fixture.checkout),
			);
			expect(runRealGit(['rev-parse', 'secondary'], fixture.checkout)).toBe(
				runRealGit(['rev-parse', 'main'], fixture.checkout),
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
				'?? LOCAL.txt',
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
				fixture.checkout,
			);
			const repositorySlug = runRealGit(
				['config', '--local', '--get', 'starsync.repository-slug'],
				fixture.checkout,
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
					fixture.checkout,
				),
			).toBe(repositoryId);
			expect(
				runRealGit(
					['config', '--local', '--get', 'starsync.repository-slug'],
					fixture.checkout,
				),
			).toBe(repositorySlug);
			expect(runRealGit(['branch', '--show-current'], fixture.checkout)).toBe('secondary');
			expect(readFileSync(localFile, 'utf8')).toBe('preserve dirty work\n');
			expect(runRealGit(['status', '--porcelain'], fixture.checkout)).toContain(
				'?? LOCAL.txt',
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
				'preserve commit',
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
});
