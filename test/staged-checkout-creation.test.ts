import { describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { RepoRecord, RefreshResult } from '../src/lib/refresh.ts';

import { STAGED_CHECKOUT_PREFIX } from '../src/lib/staged-checkout.ts';

const runCommand = (
	command: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv = {}
): string => {
	const result = Bun.spawnSync({
		cmd: [command, ...args],
		cwd,
		env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
		stderr: 'pipe',
		stdin: 'ignore',
		stdout: 'pipe',
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`${command} ${args.join(' ')} failed: ${result.stderr.toString() || result.stdout.toString()}`
		);
	}
	return result.stdout.toString().trim();
};

const runGit = (args: string[], cwd: string): string => runCommand('git', args, cwd);

const writeManagedArchiveConfig = (target: string, ownerId = 7): void => {
	mkdirSync(path.join(target, '.starsync'), { recursive: true });
	writeFileSync(
		path.join(target, '.starsync', 'config.json'),
		JSON.stringify({
			archiveFormat: 2,
			owner: { id: ownerId, login: 'archive-owner' },
		})
	);
};

const createLocalOrigin = (root: string): string => {
	const source = path.join(root, 'source');
	const origin = path.join(root, 'origin.git');
	mkdirSync(source);
	runGit(['init'], source);
	runGit(['config', 'user.email', 'starsync@example.test'], source);
	runGit(['config', 'user.name', 'StarSync Test'], source);
	writeFileSync(path.join(source, 'README.md'), '# staged checkout\n');
	runGit(['add', 'README.md'], source);
	runGit(['commit', '-m', 'initial'], source);
	runGit(['clone', '--bare', source, origin], root);
	return origin;
};

const createLocalCloneEnvironment = (
	root: string,
	githubUrl: string,
	localOrigin: string
): NodeJS.ProcessEnv => {
	const gitHome = path.join(root, 'git-home');
	mkdirSync(gitHome, { recursive: true });
	writeFileSync(
		path.join(gitHome, '.gitconfig'),
		[
			'[protocol "file"]',
			'\tallow = always',
			`[url "${pathToFileURL(localOrigin).href}"]`,
			`\tinsteadOf = ${githubUrl}`,
			'',
		].join('\n')
	);
	return { HOME: gitHome, USERPROFILE: gitHome };
};

const runStagedCheckout = (
	repository: RepoRecord,
	target: string,
	archiveOwnerId = 7,
	gitEnv: NodeJS.ProcessEnv = {}
): RefreshResult => {
	const helperPath = path.resolve('test/helpers/run-staged-checkout.ts');
	const output = runCommand(process.execPath, [helperPath, target], target, {
		...gitEnv,
		TEST_ARCHIVE_OWNER_ID: String(archiveOwnerId),
		TEST_REPOSITORY: JSON.stringify(repository),
	});
	return JSON.parse(output) as RefreshResult;
};

describe('staged checkout creation process boundary', () => {
	test('validates real Git data and identity before same-filesystem publication', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-staged-real-'));
		const target = path.join(root, 'archive');
		const cloneUrl = 'https://github.com/example/repository.git';
		const destination = path.join(target, 'repository--example');
		mkdirSync(target);
		writeManagedArchiveConfig(target);
		const origin = createLocalOrigin(root);

		try {
			const result = runStagedCheckout(
				{
					clone_url: cloneUrl,
					defaultBranch: 'main',
					folderName: 'repository--example',
					id: 321,
					name: 'repository',
					slug: 'example/repository',
				},
				target,
				7,
				createLocalCloneEnvironment(root, cloneUrl, origin)
			);

			expect(result).toEqual(
				expect.objectContaining({ name: 'repository--example', outcome: 'added' })
			);
			expect(existsSync(path.join(destination, '.git'))).toBe(true);
			expect(runGit(['config', '--local', '--get', 'remote.origin.url'], destination)).toBe(
				cloneUrl
			);
			expect(
				runGit(['config', '--local', '--get', 'starsync.repository-id'], destination)
			).toBe('321');
			expect(
				runGit(['config', '--local', '--get', 'starsync.repository-slug'], destination)
			).toBe('example/repository');
			expect(runGit(['fsck', '--full'], destination)).toBe('');
			expect(
				readdirSync(target).filter((name) => name.startsWith(STAGED_CHECKOUT_PREFIX))
			).toEqual([]);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('cleans only its staging directory when clone fails', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-staged-failure-'));
		const target = path.join(root, 'archive');
		const unrelated = path.join(target, 'existing--owner');
		const marker = path.join(unrelated, 'keep.txt');
		const cloneUrl = 'https://github.com/example/missing.git';
		mkdirSync(unrelated, { recursive: true });
		writeFileSync(marker, 'keep');
		writeManagedArchiveConfig(target);

		try {
			const result = runStagedCheckout(
				{
					clone_url: cloneUrl,
					defaultBranch: 'main',
					folderName: 'missing--example',
					id: 654,
					name: 'missing',
					slug: 'example/missing',
				},
				target,
				7,
				createLocalCloneEnvironment(root, cloneUrl, path.join(root, 'missing.git'))
			);

			expect(result.outcome).toBe('failed');
			expect(readFileSync(marker, 'utf8')).toBe('keep');
			expect(existsSync(path.join(target, 'missing--example'))).toBe(false);
			expect(
				readdirSync(target).filter((name) => name.startsWith(STAGED_CHECKOUT_PREFIX))
			).toEqual([]);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('rejects origin, archive-owner, and destination mismatches before cloning', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-staged-guards-'));
		const target = path.join(root, 'archive');
		const destination = path.join(target, 'repository--example');
		const marker = path.join(destination, 'keep.txt');
		mkdirSync(destination, { recursive: true });
		writeFileSync(marker, 'keep');
		writeManagedArchiveConfig(target, 8);

		try {
			const repository = {
				clone_url: 'https://github.com/example/repository.git',
				defaultBranch: 'main',
				folderName: 'repository--example',
				id: 321,
				name: 'repository',
				slug: 'example/repository',
			};
			const originMismatch = runStagedCheckout(
				{
					...repository,
					clone_url: 'https://github.com/other/repository.git',
				},
				target,
				7
			);
			expect(originMismatch.outcome).toBe('failed');
			expect(originMismatch.message).toContain('matching GitHub.com origin');

			const ownerMismatch = runStagedCheckout(repository, target, 7);
			expect(ownerMismatch.outcome).toBe('failed');
			expect(ownerMismatch.message).toContain('Archive owner identity changed');

			writeManagedArchiveConfig(target, 7);
			const destinationCollision = runStagedCheckout(repository, target, 7);
			expect(destinationCollision.outcome).toBe('failed');
			expect(destinationCollision.message).toContain('already occupied');
			expect(readFileSync(marker, 'utf8')).toBe('keep');
			expect(
				readdirSync(target).filter((name) => name.startsWith(STAGED_CHECKOUT_PREFIX))
			).toEqual([]);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});
});
