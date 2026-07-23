import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	rmdirSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { MigrationPreviewResult } from '../src/lib/archive-migration.ts';

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

const createGitCheckout = (
	root: string,
	name: string,
	owner = 'owner',
	repository = 'repository'
): string => {
	const checkout = path.join(root, name);
	mkdirSync(checkout);
	run(['git', 'init'], checkout);
	run(['git', 'config', 'user.name', 'StarSync Test'], checkout);
	run(['git', 'config', 'user.email', 'starsync@example.invalid'], checkout);
	writeFileSync(path.join(checkout, 'README.md'), '# fixture\n');
	run(['git', 'add', 'README.md'], checkout);
	run(['git', 'commit', '-m', 'initial'], checkout);
	run(
		['git', 'remote', 'add', 'origin', `https://github.com/${owner}/${repository}.git`],
		checkout
	);
	return checkout;
};

const applyMigration = (
	targetPath: string,
	repositoryName = 'repository',
	useOriginName = false
): MigrationPreviewResult => {
	const helperPath = path.resolve('test/helpers/run-migration-apply.ts');
	const result = spawnSync(process.execPath, [helperPath, targetPath], {
		encoding: 'utf-8',
		env: {
			...process.env,
			TEST_REPOSITORY_NAME: repositoryName,
			TEST_USE_ORIGIN_NAME: useOriginName ? '1' : '0',
		},
	});
	if (result.status !== 0) {
		throw new Error(`Migration helper failed: ${result.stderr || result.stdout}`);
	}
	return JSON.parse(result.stdout) as MigrationPreviewResult;
};

describe('managed checkout migration process boundary', () => {
	test('records real local Git identity, renames safely, finalizes, and reruns idempotently', () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-migration-apply-'));
		try {
			createGitCheckout(target, 'legacy-name');

			const first = applyMigration(target);
			const canonicalPath = path.join(target, 'repository--owner');

			expect(first.exitCode).toBe(0);
			expect(first.checkouts[0]).toEqual(
				expect.objectContaining({
					name: 'repository--owner',
					outcome: 'updated',
					pendingRename: false,
				})
			);
			expect(existsSync(canonicalPath)).toBe(true);
			expect(existsSync(path.join(target, 'legacy-name'))).toBe(false);
			expect(
				run(['git', 'config', '--local', '--get', 'starsync.repository-id'], canonicalPath)
			).toBe('42');
			expect(
				run(
					['git', 'config', '--local', '--get', 'starsync.repository-slug'],
					canonicalPath
				)
			).toBe('owner/repository');
			expect(run(['git', 'config', '--get', 'remote.origin.url'], canonicalPath)).toBe(
				'https://github.com/owner/repository.git'
			);
			expect(
				JSON.parse(readFileSync(path.join(target, '.starsync', 'config.json'), 'utf-8'))
			).toEqual({
				archiveFormat: 2,
				owner: { id: 7, login: 'archive-owner' },
			});
			expect(readdirSync(path.join(target, '.starsync'))).toEqual(['config.json']);

			const second = applyMigration(target);
			expect(second.exitCode).toBe(0);
			expect(second.checkouts[0]?.outcome).toBe('current');
			expect(readdirSync(target).sort()).toEqual(['.starsync', 'repository--owner']);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('adopts a dirty checkout without renaming its work', () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-migration-dirty-'));
		try {
			const checkout = createGitCheckout(target, 'dirty-checkout');
			writeFileSync(path.join(checkout, 'local-work.txt'), 'preserve me');

			const report = applyMigration(target);

			expect(report.exitCode).toBe(0);
			expect(report.checkouts[0]).toEqual(
				expect.objectContaining({
					lifecycle: 'blocked',
					name: 'dirty-checkout',
					outcome: 'updated',
					pendingRename: true,
				})
			);
			expect(readFileSync(path.join(checkout, 'local-work.txt'), 'utf-8')).toBe(
				'preserve me'
			);
			expect(
				run(['git', 'config', '--local', '--get', 'starsync.repository-id'], checkout)
			).toBe('42');
			expect(existsSync(path.join(target, '.starsync', 'migration-state.json'))).toBe(false);
			expect(existsSync(path.join(target, '.starsync', 'config.json'))).toBe(true);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('detects a collision before renaming and resumes after the conflict is removed', () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-migration-resume-'));
		try {
			createGitCheckout(target, 'good-legacy', 'owner', 'good');
			createGitCheckout(target, 'bad-legacy', 'owner', 'bad');
			const collisionPath = path.join(target, 'bad--owner');
			mkdirSync(collisionPath);

			const blocked = applyMigration(target, 'repository', true);

			expect(blocked.exitCode).toBe(1);
			expect(
				blocked.checkouts.some(
					(checkout) => checkout.findings[0]?.code === 'migration-name-collision'
				)
			).toBe(true);
			expect(existsSync(path.join(target, 'good--owner'))).toBe(true);
			expect(existsSync(path.join(target, 'good-legacy'))).toBe(false);
			expect(existsSync(path.join(target, 'bad-legacy'))).toBe(true);
			expect(existsSync(path.join(target, '.starsync', 'migration-state.json'))).toBe(true);
			expect(existsSync(path.join(target, '.starsync', 'config.json'))).toBe(false);

			rmdirSync(collisionPath);
			const resumed = applyMigration(target, 'repository', true);

			expect(resumed.exitCode).toBe(0);
			expect(existsSync(path.join(target, 'good--owner'))).toBe(true);
			expect(existsSync(path.join(target, 'bad--owner'))).toBe(true);
			expect(existsSync(path.join(target, '.starsync', 'migration-state.json'))).toBe(false);
			expect(existsSync(path.join(target, '.starsync', 'config.json'))).toBe(true);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});
});
