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

import type { RenameResult } from '../src/lib/archive-rename.ts';

import { parseGitHubRepositorySlug } from '../src/lib/repository-resolution.ts';

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

const repositoryId = (repository: string): number =>
	[...repository].reduce((total, character) => total + character.charCodeAt(0), 100);

const writeArchiveConfig = (target: string): void => {
	mkdirSync(path.join(target, '.starsync'));
	writeFileSync(
		path.join(target, '.starsync', 'config.json'),
		JSON.stringify({ archiveFormat: 2, owner: { id: 7, login: 'archive-owner' } })
	);
};

const createGitCheckout = (
	root: string,
	name: string,
	owner = 'old-owner',
	repository = 'repository',
	identityId = 42
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
	run(['git', 'config', '--local', 'starsync.repository-id', String(identityId)], checkout);
	run(
		['git', 'config', '--local', 'starsync.repository-slug', `${owner}/${repository}`],
		checkout
	);
	return checkout;
};

const runRenames = (
	targetPath: string,
	options: {
		previewOnly?: boolean;
		repositoryName?: string;
		repositoryOwner?: string;
		useOriginName?: boolean;
	} = {}
): RenameResult => {
	const helperPath = path.resolve('test/helpers/run-rename-apply.ts');
	const result = spawnSync(process.execPath, [helperPath, targetPath], {
		encoding: 'utf-8',
		env: {
			...process.env,
			TEST_PREVIEW_ONLY: options.previewOnly ? '1' : '0',
			TEST_REPOSITORY_NAME: options.repositoryName ?? 'repository',
			TEST_REPOSITORY_OWNER: options.repositoryOwner ?? 'owner',
			TEST_USE_ORIGIN_NAME: options.useOriginName ? '1' : '0',
		},
	});
	if (result.status !== 0) {
		throw new Error(`Rename helper failed: ${result.stderr || result.stdout}`);
	}
	return JSON.parse(result.stdout) as RenameResult;
};

const applyRenames = (targetPath: string, useOriginName = false): RenameResult =>
	runRenames(targetPath, { useOriginName });

describe('managed checkout rename process boundary', () => {
	test('updates current identity metadata, origin, and folder, then reruns idempotently', () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-rename-apply-'));
		try {
			writeArchiveConfig(target);
			createGitCheckout(target, 'repository--old-owner');

			const first = applyRenames(target);
			const canonicalPath = path.join(target, 'repository--owner');

			expect(first.exitCode).toBe(0);
			expect(first.checkouts[0]).toEqual(
				expect.objectContaining({
					name: 'repository--owner',
					outcome: 'updated',
					pendingRename: false,
				})
			);
			expect(first.checkouts[0]?.plannedOutcome).toBeUndefined();
			expect(existsSync(canonicalPath)).toBe(true);
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
			expect(readdirSync(path.join(target, '.starsync'))).toEqual(['config.json']);

			const second = applyRenames(target);
			expect(second.exitCode).toBe(0);
			expect(second.checkouts[0]?.outcome).toBe('current');
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('previews and publishes exact owner-only and repository-only casing changes', () => {
		for (const repository of [
			{ name: 'repository', owner: 'Owner', proposedName: 'repository--Owner' },
			{ name: 'Repository', owner: 'owner', proposedName: 'Repository--owner' },
		]) {
			const target = mkdtempSync(path.join(tmpdir(), 'starsync-rename-casing-'));
			try {
				writeArchiveConfig(target);
				createGitCheckout(target, 'repository--owner', 'owner', 'repository');
				const options = {
					repositoryName: repository.name,
					repositoryOwner: repository.owner,
				};

				const preview = runRenames(target, { ...options, previewOnly: true });
				expect(preview.checkouts[0]).toEqual(
					expect.objectContaining({
						pendingRename: true,
						rename: expect.objectContaining({
							classification: 'pending',
							proposedName: repository.proposedName,
						}),
					})
				);

				const applied = runRenames(target, options);
				expect(applied.checkouts[0]?.name).toBe(repository.proposedName);
				expect(readdirSync(target).sort()).toEqual(
					['.starsync', repository.proposedName].sort()
				);
				const canonicalPath = path.join(target, repository.proposedName);
				expect(
					run(
						['git', 'config', '--local', '--get', 'starsync.repository-slug'],
						canonicalPath
					)
				).toBe(`${repository.owner}/${repository.name}`);
				expect(run(['git', 'config', '--get', 'remote.origin.url'], canonicalPath)).toBe(
					`https://github.com/${repository.owner}/${repository.name}.git`
				);
			} finally {
				rmSync(target, { force: true, recursive: true });
			}
		}
	});

	test('blocks a dirty checkout without changing identity, origin, or local work', () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-rename-dirty-'));
		try {
			writeArchiveConfig(target);
			const checkout = createGitCheckout(target, 'repository--old-owner');
			writeFileSync(path.join(checkout, 'local-work.txt'), 'preserve me');

			const report = applyRenames(target);

			expect(report.exitCode).toBe(1);
			expect(report.checkouts[0]).toEqual(
				expect.objectContaining({
					lifecycle: 'blocked',
					name: 'repository--old-owner',
					outcome: 'skipped',
				})
			);
			expect(readFileSync(path.join(checkout, 'local-work.txt'), 'utf-8')).toBe(
				'preserve me'
			);
			expect(
				run(['git', 'config', '--local', '--get', 'starsync.repository-slug'], checkout)
			).toBe('old-owner/repository');
			expect(existsSync(path.join(target, 'repository--owner'))).toBe(false);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('rejects a stored repository ID that does not match GitHub resolution', () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-rename-identity-mismatch-'));
		try {
			writeArchiveConfig(target);
			createGitCheckout(target, 'repository--old-owner', 'old-owner', 'repository', 99);

			const report = applyRenames(target);

			expect(report.exitCode).toBe(1);
			expect(report.checkouts[0]?.findings[0]?.code).toBe('repository-identity-mismatch');
			expect(existsSync(path.join(target, 'repository--old-owner'))).toBe(true);
			expect(existsSync(path.join(target, 'repository--owner'))).toBe(false);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('reports a collision while preserving successful checkout updates without state files', () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-rename-partial-'));
		try {
			writeArchiveConfig(target);
			createGitCheckout(target, 'good--old-owner', 'old-owner', 'good', repositoryId('good'));
			createGitCheckout(target, 'bad--old-owner', 'old-owner', 'bad', repositoryId('bad'));
			const collisionPath = path.join(target, 'bad--owner');
			mkdirSync(collisionPath);

			const partial = applyRenames(target, true);

			expect(partial.exitCode).toBe(1);
			expect(
				partial.checkouts.some(
					(checkout) => checkout.findings[0]?.code === 'rename-name-collision'
				)
			).toBe(true);
			expect(existsSync(path.join(target, 'good--owner'))).toBe(true);
			expect(existsSync(path.join(target, 'bad--old-owner'))).toBe(true);
			expect(readdirSync(path.join(target, '.starsync'))).toEqual(['config.json']);

			rmdirSync(collisionPath);
			const completed = applyRenames(target, true);
			expect(completed.exitCode).toBe(0);
			expect(existsSync(path.join(target, 'bad--owner'))).toBe(true);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});
});

describe('GitHub repository slug parsing', () => {
	test('parses HTTPS, SSH URL, and SCP-style SSH origins', () => {
		expect(parseGitHubRepositorySlug('https://github.com/owner/repository.git')).toEqual({
			owner: 'owner',
			repository: 'repository',
		});
		expect(parseGitHubRepositorySlug('ssh://git@github.com/owner/repository.git')).toEqual({
			owner: 'owner',
			repository: 'repository',
		});
		expect(parseGitHubRepositorySlug('git@github.com:owner/repository.git')).toEqual({
			owner: 'owner',
			repository: 'repository',
		});
	});

	test('rejects query strings, fragments, wrong path shapes, and non-GitHub hosts', () => {
		for (const origin of [
			'https://github.com/owner/repository.git?ref=main',
			'https://github.com/owner/repository.git#readme',
			'https://github.com/owner',
			'https://github.com/owner/repository/extra',
			'https://token@github.com/owner/repository.git',
			'git@github.com:owner/repository/extra.git',
			'https://gitlab.com/owner/repository.git',
			'git@gitlab.com:owner/repository.git',
		]) {
			expect(parseGitHubRepositorySlug(origin)).toBeNull();
		}
	});
});
