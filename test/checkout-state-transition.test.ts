import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ArchiveEntry } from '../src/lib/archive-inspection.ts';
import type { CheckoutStateRunner } from '../src/lib/checkout-state-transition.ts';
import type { CheckoutReport } from '../src/lib/reporting.ts';

import { applyCheckoutRename } from '../src/lib/checkout-rename-apply.ts';
import { transitionCheckoutState } from '../src/lib/checkout-state-transition.ts';
import { runGit } from '../src/lib/git-exec.ts';

const run = (args: string[], cwd: string): string => {
	const result = spawnSync(args[0]!, args.slice(1), {
		cwd,
		encoding: 'utf-8',
		env: { ...process.env, GIT_AUTHOR_EMAIL: 'starsync@example.invalid' },
	});
	if (result.status !== 0) {
		throw new Error(`${args.join(' ')} failed: ${result.stderr || result.stdout}`);
	}
	return result.stdout.trim();
};

const createCheckout = (root: string): string => {
	const checkout = path.join(root, 'repository--old-owner');
	mkdirSync(checkout);
	run(['git', 'init'], checkout);
	run(['git', 'config', 'user.name', 'StarSync Test'], checkout);
	run(['git', 'config', 'user.email', 'starsync@example.invalid'], checkout);
	writeFileSync(path.join(checkout, 'README.md'), '# fixture\n');
	run(['git', 'add', 'README.md'], checkout);
	run(['git', 'commit', '-m', 'initial'], checkout);
	run(
		['git', 'remote', 'add', 'origin', 'https://github.com/old-owner/repository.git'],
		checkout
	);
	run(['git', 'config', '--local', 'starsync.repository-id', '42'], checkout);
	run(['git', 'config', '--local', 'starsync.repository-slug', 'old-owner/repository'], checkout);
	return checkout;
};

const readLabels = (checkout: string): { id: string; origin: string; slug: string } => ({
	id: run(['git', 'config', '--local', '--get', 'starsync.repository-id'], checkout),
	origin: run(['git', 'config', '--local', '--get', 'remote.origin.url'], checkout),
	slug: run(['git', 'config', '--local', '--get', 'starsync.repository-slug'], checkout),
});

const isMutation = (args: string[]): boolean =>
	(args[0] === 'remote' && args[1] === 'set-url') ||
	(args[0] === 'config' && !args.includes('--get'));

const failAfterMutation = (boundary: number, afterFailure?: () => void): CheckoutStateRunner => {
	let mutationCount = 0;
	let failed = false;
	return async (args, options) => {
		const output = await runGit(args, options);
		if (!failed && isMutation(args) && ++mutationCount === boundary) {
			failed = true;
			afterFailure?.();
			throw new Error(`injected failure after mutation ${boundary}`);
		}
		return output;
	};
};

const pendingRename = (
	repositorySlug = 'new-owner/repository',
	proposedName = 'repository--new-owner'
): CheckoutReport => ({
	findings: [],
	lifecycle: 'active',
	name: 'repository--old-owner',
	outcome: 'current',
	pendingRename: true,
	plannedOutcome: 'updated',
	rename: {
		classification: 'pending',
		proposedName,
		repositoryId: 42,
		repositorySlug,
	},
});

const archiveEntry = (checkout: string): ArchiveEntry => ({
	gitError: null,
	isGitCheckout: true,
	name: path.basename(checkout),
	origin: 'https://github.com/old-owner/repository.git',
	path: checkout,
});

describe('checkout state transitions', () => {
	for (const boundary of [1, 2, 3]) {
		test(`restores every label after mutation boundary ${boundary} fails`, async () => {
			const target = mkdtempSync(path.join(tmpdir(), 'starsync-state-rollback-'));
			try {
				const checkout = createCheckout(target);
				await expect(
					transitionCheckoutState(
						checkout,
						{ repositoryId: 42, repositorySlug: 'new-owner/repository' },
						failAfterMutation(boundary)
					)
				).rejects.toThrow(`injected failure after mutation ${boundary}`);
				expect(readLabels(checkout)).toEqual({
					id: '42',
					origin: 'https://github.com/old-owner/repository.git',
					slug: 'old-owner/repository',
				});
			} finally {
				rmSync(target, { force: true, recursive: true });
			}
		});
	}

	test('reports original and rollback failures together', async () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-state-compound-'));
		try {
			const checkout = createCheckout(target);
			let rollingBack = false;
			const runner: CheckoutStateRunner = async (args, options) => {
				if (rollingBack && args.at(-1) === 'https://github.com/old-owner/repository.git') {
					throw new Error('injected rollback origin failure');
				}
				const output = await runGit(args, options);
				if (args.at(-1) === 'new-owner/repository') {
					rollingBack = true;
					throw new Error('injected original slug failure');
				}
				return output;
			};

			await expect(
				transitionCheckoutState(
					checkout,
					{ repositoryId: 42, repositorySlug: 'new-owner/repository' },
					runner
				)
			).rejects.toThrow(
				/injected original slug failure.*Rollback also failed.*rollback origin/
			);
			expect(readLabels(checkout)).toEqual({
				id: '42',
				origin: 'https://github.com/new-owner/repository.git',
				slug: 'old-owner/repository',
			});
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('commits origin, repository ID, and slug as one verified state', async () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-state-success-'));
		try {
			const checkout = createCheckout(target);
			await transitionCheckoutState(checkout, {
				repositoryId: 42,
				repositorySlug: 'new-owner/repository',
			});
			expect(readLabels(checkout)).toEqual({
				id: '42',
				origin: 'https://github.com/new-owner/repository.git',
				slug: 'new-owner/repository',
			});
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('rejects a stable repository ID change before mutating labels', async () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-state-identity-'));
		try {
			const checkout = createCheckout(target);
			await expect(
				transitionCheckoutState(checkout, {
					repositoryId: 84,
					repositorySlug: 'new-owner/repository',
				})
			).rejects.toThrow('Cannot change a managed checkout stable repository identity.');
			expect(readLabels(checkout)).toEqual({
				id: '42',
				origin: 'https://github.com/old-owner/repository.git',
				slug: 'old-owner/repository',
			});
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});
});

describe('checkout folder compensation', () => {
	test('moves the folder back after a metadata transition failure', async () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-folder-rollback-'));
		try {
			const checkout = createCheckout(target);
			const result = await applyCheckoutRename(
				target,
				pendingRename(),
				[archiveEntry(checkout)],
				{
					runGit: failAfterMutation(1),
				}
			);

			expect(result.applied).toBe(false);
			expect(result.report.findings[0]?.message).toContain(
				'injected failure after mutation 1'
			);
			expect(existsSync(checkout)).toBe(true);
			expect(existsSync(path.join(target, 'repository--new-owner'))).toBe(false);
			expect(readLabels(checkout).slug).toBe('old-owner/repository');
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('restores exact original casing after a case-only metadata failure', async () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-folder-case-rollback-'));
		try {
			const checkout = createCheckout(target);
			const result = await applyCheckoutRename(
				target,
				pendingRename('Old-Owner/repository', 'repository--Old-Owner'),
				[archiveEntry(checkout)],
				{ runGit: failAfterMutation(1) }
			);

			expect(result.applied).toBe(false);
			expect(result.report.findings[0]?.message).toContain(
				'injected failure after mutation 1'
			);
			expect(readdirSync(target)).toEqual(['repository--old-owner']);
			expect(readLabels(checkout).slug).toBe('old-owner/repository');
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('never overwrites an original path occupied during rollback', async () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-folder-collision-'));
		try {
			const checkout = createCheckout(target);
			const marker = path.join(checkout, 'user-owned.txt');
			const result = await applyCheckoutRename(
				target,
				pendingRename(),
				[archiveEntry(checkout)],
				{
					runGit: failAfterMutation(1, () => {
						mkdirSync(checkout);
						writeFileSync(marker, 'preserve');
					}),
				}
			);
			const movedCheckout = path.join(target, 'repository--new-owner');

			expect(result.applied).toBe(false);
			expect(result.report.findings[0]?.message).toContain('Folder rollback also failed');
			expect(result.report.findings[0]?.message).toContain('original path is occupied');
			expect(readFileSync(marker, 'utf-8')).toBe('preserve');
			expect(existsSync(movedCheckout)).toBe(true);
			expect(readLabels(movedCheckout).slug).toBe('old-owner/repository');
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});
});
