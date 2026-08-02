import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { StarredRepositoryRecord } from '../src/lib/managed-checkout-planning.ts';

import { planManagedSync } from '../src/lib/managed-checkout-planning.ts';

const runGit = (args: string[], cwd: string): void => {
	const result = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd,
		stderr: 'pipe',
		stdin: 'ignore',
		stdout: 'pipe',
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
};

const repository = (name: string, id: number, slug = `owner/${name}`): StarredRepositoryRecord => ({
	clone_url: `https://github.com/${slug}.git`,
	defaultBranch: 'main',
	id,
	name,
	slug,
});

const createGitCheckout = (root: string, name: string): string => {
	const checkoutPath = path.join(root, name);
	mkdirSync(checkoutPath);
	runGit(['init', '--quiet'], checkoutPath);
	return checkoutPath;
};

const createManagedCheckout = (root: string, name: string, id: number, slug: string): void => {
	const checkoutPath = createGitCheckout(root, name);
	runGit(
		['config', '--local', 'remote.origin.url', `https://github.com/${slug}.git`],
		checkoutPath
	);
	runGit(['config', '--local', 'starsync.repository-id', String(id)], checkoutPath);
	runGit(['config', '--local', 'starsync.repository-slug', slug], checkoutPath);
};

const findingCodes = (reports: Awaited<ReturnType<typeof planManagedSync>>['blockedReports']) =>
	reports.map((report) => report.findings[0]?.code);

describe('managed checkout planning', () => {
	test('rejects invalid IDs and slugs while preserving valid repository order', async () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-plan-invalid-'));
		try {
			const plan = await planManagedSync(target, [
				repository('bad-id', 0),
				repository('bad-slug', 2, 'not-a-slug'),
				repository('same-id', 2),
				repository('second', 3),
				repository('first', 4),
			]);

			expect(findingCodes(plan.blockedReports)).toEqual([
				'invalid-repository-identity',
				'invalid-repository-identity',
				'duplicate-identity',
			]);
			expect(plan.repositories.map((entry) => entry.name)).toEqual(['second', 'first']);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('classifies duplicate identities, duplicate destinations, and occupied folders', async () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-plan-collisions-'));
		try {
			mkdirSync(path.join(target, 'occupied--owner'));
			const plan = await planManagedSync(target, [
				repository('alpha', 10),
				repository('beta', 10),
				repository('shared-one', 11, 'owner/shared'),
				repository('shared-two', 12, 'owner/shared'),
				repository('occupied', 13),
				repository('valid', 14),
			]);

			expect(findingCodes(plan.blockedReports)).toEqual([
				'duplicate-identity',
				'duplicate-identity',
				'rename-name-collision',
				'rename-name-collision',
				'checkout-name-collision',
			]);
			expect(plan.repositories.map((entry) => entry.folderName)).toEqual(['valid--owner']);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('filters every checkout that shares a managed repository identity', async () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-plan-duplicate-checkouts-'));
		try {
			createManagedCheckout(target, 'one--owner', 20, 'owner/one');
			createManagedCheckout(target, 'two--owner', 20, 'owner/two');

			const plan = await planManagedSync(target, []);

			expect(plan.repositories).toEqual([]);
			expect(plan.retainedReports).toEqual([]);
			expect(findingCodes(plan.blockedReports)).toEqual([
				'duplicate-identity',
				'duplicate-identity',
			]);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('combines pending renames, retained checkouts, and invalid entries in one archive', async () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-plan-mixed-'));
		try {
			createManagedCheckout(target, 'original--old-owner', 30, 'old-owner/original');
			createManagedCheckout(target, 'retained--owner', 31, 'owner/retained');
			createGitCheckout(target, 'invalid--owner');
			mkdirSync(path.join(target, 'notes'));

			const plan = await planManagedSync(target, [
				repository('fresh', 32),
				repository('renamed', 30, 'new-owner/renamed'),
			]);

			expect(plan.repositories.map((entry) => entry.folderName)).toEqual([
				'fresh--owner',
				'original--old-owner',
			]);
			expect(plan.repositories[1]?.pendingRename).toBe(true);
			expect(plan.retainedReports).toEqual([
				expect.objectContaining({
					lifecycle: 'retained',
					name: 'retained--owner',
					outcome: 'skipped',
				}),
			]);
			expect(findingCodes(plan.blockedReports)).toEqual(['missing-identity-metadata']);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});
});
