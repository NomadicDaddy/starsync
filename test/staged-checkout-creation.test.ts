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

import type { ArchiveVerificationResult } from '../src/lib/archive-verification.ts';
import type { RefreshResult, RepoRecord } from '../src/lib/refresh.ts';

import { inspectArchive } from '../src/lib/archive-inspection.ts';
import { acquireArchiveLock, releaseArchiveLock } from '../src/lib/archive-lock.ts';
import { planManagedSync } from '../src/lib/managed-checkout-planning.ts';
import {
	cleanupOwnedCheckoutArtifacts,
	DAMAGED_CHECKOUT_PREFIX,
	STAGED_CHECKOUT_PREFIX,
} from '../src/lib/owned-checkout-artifacts.ts';

const runCommand = (
	command: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv = {},
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
			`${command} ${args.join(' ')} failed: ${result.stderr.toString() || result.stdout.toString()}`,
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
		}),
	);
};

const createLocalOrigin = (root: string, invalidWindowsPath?: string): string => {
	const source = path.join(root, 'source');
	const origin = path.join(root, 'origin.git');
	mkdirSync(source);
	runGit(['init'], source);
	runGit(['config', 'user.email', 'starsync@example.test'], source);
	runGit(['config', 'user.name', 'StarSync Test'], source);
	writeFileSync(path.join(source, 'README.md'), '# staged checkout\n');
	runGit(['add', 'README.md'], source);
	runGit(['commit', '-m', 'initial'], source);
	if (invalidWindowsPath !== undefined) {
		const blobSource = path.join(source, 'invalid-path-blob');
		writeFileSync(blobSource, 'retained in Git objects\n');
		const blob = runGit(['hash-object', '-w', blobSource], source);
		runGit(['config', 'core.protectNTFS', 'false'], source);
		runGit(
			['update-index', '--add', '--cacheinfo', `100644,${blob},${invalidWindowsPath}`],
			source,
		);
		runGit(['commit', '-m', 'add Windows-incompatible path'], source);
	}
	runGit(['clone', '--bare', source, origin], root);
	return origin;
};

const createLocalCloneEnvironment = (
	root: string,
	githubUrls: string | string[],
	localOrigin: string,
): NodeJS.ProcessEnv => {
	const gitHome = path.join(root, 'git-home');
	mkdirSync(gitHome, { recursive: true });
	const urls = Array.isArray(githubUrls) ? githubUrls : [githubUrls];
	writeFileSync(
		path.join(gitHome, '.gitconfig'),
		[
			'[protocol "file"]',
			'\tallow = always',
			...urls.flatMap((githubUrl) => [
				`[url "${pathToFileURL(localOrigin).href}"]`,
				`\tinsteadOf = ${githubUrl}`,
			]),
			'',
		].join('\n'),
	);
	return { HOME: gitHome, USERPROFILE: gitHome };
};

const runStagedCheckout = (
	repository: RepoRecord,
	target: string,
	archiveOwnerId = 7,
	gitEnv: NodeJS.ProcessEnv = {},
): RefreshResult => {
	const helperPath = path.resolve('test/helpers/run-staged-checkout.ts');
	const output = runCommand(process.execPath, [helperPath, target], target, {
		...gitEnv,
		TEST_ARCHIVE_OWNER_ID: String(archiveOwnerId),
		TEST_REPOSITORY: JSON.stringify(repository),
	});
	return JSON.parse(output) as RefreshResult;
};

const runForcedVerification = (
	target: string,
	repository: {
		id: number;
		name: string;
		owner: string;
		slug: string;
	},
	gitEnv: NodeJS.ProcessEnv,
	repositoryAliases: string[] = [],
	failDamagedCleanup = false,
): ArchiveVerificationResult => {
	const helperPath = path.resolve('test/helpers/run-forced-verification.ts');
	const output = runCommand(process.execPath, [helperPath, target], target, {
		...gitEnv,
		TEST_FAIL_DAMAGED_CLEANUP: failDamagedCleanup ? '1' : '0',
		TEST_REPOSITORY_ALIASES: JSON.stringify(repositoryAliases),
		TEST_RESOLVED_REPOSITORY: JSON.stringify(repository),
	});
	return JSON.parse(output) as ArchiveVerificationResult;
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
				createLocalCloneEnvironment(root, cloneUrl, origin),
			);

			expect(result).toEqual(
				expect.objectContaining({ name: 'repository--example', outcome: 'added' }),
			);
			expect(existsSync(path.join(destination, '.git'))).toBe(true);
			expect(runGit(['config', '--local', '--get', 'remote.origin.url'], destination)).toBe(
				cloneUrl,
			);
			expect(
				runGit(['config', '--local', '--get', 'starsync.repository-id'], destination),
			).toBe('321');
			expect(
				runGit(['config', '--local', '--get', 'starsync.repository-slug'], destination),
			).toBe('example/repository');
			expect(runGit(['fsck', '--full'], destination)).toBe('');
			expect(
				readdirSync(target).filter((name) => name.startsWith(STAGED_CHECKOUT_PREFIX)),
			).toEqual([]);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('retains Windows-incompatible paths in Git while producing a clean checkout', () => {
		if (process.platform !== 'win32') return;
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-staged-windows-path-'));
		const target = path.join(root, 'archive');
		const cloneUrl = 'https://github.com/example/windows-paths.git';
		const destination = path.join(target, 'windows-paths--example');
		const invalidPath = 'screens/localhost:5287.png';
		mkdirSync(target);
		writeManagedArchiveConfig(target);
		const origin = createLocalOrigin(root, invalidPath);

		try {
			const result = runStagedCheckout(
				{
					clone_url: cloneUrl,
					defaultBranch: 'main',
					folderName: 'windows-paths--example',
					id: 987,
					name: 'windows-paths',
					slug: 'example/windows-paths',
				},
				target,
				7,
				createLocalCloneEnvironment(root, cloneUrl, origin),
			);

			expect(result).toEqual(expect.objectContaining({ outcome: 'added' }));
			expect(runGit(['status', '--porcelain'], destination)).toBe('');
			expect(runGit(['ls-tree', '-r', '--name-only', 'HEAD'], destination)).toContain(
				invalidPath,
			);
			expect(runGit(['ls-files', '-v', '--', invalidPath], destination)).toBe(
				`S ${invalidPath}`,
			);
			expect(existsSync(path.join(destination, invalidPath))).toBe(false);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('replaces damaged and locally modified checkouts after validating fresh clones', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-staged-replace-'));
		const target = path.join(root, 'archive');
		const cloneUrl = 'https://github.com/example/repository.git';
		const destination = path.join(target, 'repository--example');
		mkdirSync(target);
		writeManagedArchiveConfig(target);
		const origin = createLocalOrigin(root);
		const gitEnv = createLocalCloneEnvironment(root, cloneUrl, origin);

		try {
			const added = runStagedCheckout(
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
				gitEnv,
			);
			expect(added.outcome).toBe('added');
			writeFileSync(path.join(destination, 'damaged-only.txt'), 'discard me');
			writeFileSync(path.join(destination, '.git', 'config'), '\0'.repeat(256));

			const result = runForcedVerification(
				target,
				{
					id: 321,
					name: 'repository',
					owner: 'example',
					slug: 'example/repository',
				},
				gitEnv,
			);
			const checkout = result.checkouts[0];

			expect(result.exitCode).toBe(0);
			expect(checkout?.outcome).toBe('updated');
			expect(checkout?.findings.some((finding) => finding.code === 'checkout-recloned')).toBe(
				true,
			);
			expect(existsSync(path.join(destination, 'damaged-only.txt'))).toBe(false);
			expect(
				runGit(['config', '--local', '--get', 'starsync.repository-id'], destination),
			).toBe('321');
			expect(runGit(['fsck', '--full'], destination)).toBe('');
			expect(
				readdirSync(target).filter(
					(name) =>
						name.startsWith(STAGED_CHECKOUT_PREFIX) ||
						name.startsWith(DAMAGED_CHECKOUT_PREFIX),
				),
			).toEqual([]);

			const localChange = path.join(destination, 'local-change.txt');
			writeFileSync(localChange, 'discard me too');
			const dirtyResult = runForcedVerification(
				target,
				{
					id: 321,
					name: 'repository',
					owner: 'example',
					slug: 'example/repository',
				},
				gitEnv,
			);

			expect(dirtyResult.exitCode).toBe(0);
			expect(dirtyResult.checkouts[0]?.outcome).toBe('updated');
			expect(
				dirtyResult.checkouts[0]?.findings.some(
					(finding) => finding.code === 'checkout-recloned',
				),
			).toBe(true);
			expect(existsSync(localChange)).toBe(false);
			expect(runGit(['status', '--porcelain'], destination)).toBe('');
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	// Each rename reaches the same current identity from a different previous one, so the current
	// folder and slug are fixed and only the old pair varies per case.
	const currentFolder = 'repository--example';
	const currentSlug = 'example/repository';

	test.each([
		['owner', 'repository--previous', 'previous/repository'],
		['name', 'previous--example', 'example/previous'],
		['casing', 'Repository--Example', 'Example/Repository'],
	])(
		'recovers a dirty valid-ID checkout after a %s rename',
		(label, oldFolder, oldSlug) => {
			const root = mkdtempSync(path.join(tmpdir(), `starsync-force-${label}-`));
			const target = path.join(root, 'archive');
			const oldCloneUrl = `https://github.com/${oldSlug}.git`;
			const currentCloneUrl = `https://github.com/${currentSlug}.git`;
			const source = path.join(target, oldFolder);
			const destination = path.join(target, currentFolder);
			mkdirSync(target);
			writeManagedArchiveConfig(target);
			const origin = createLocalOrigin(root);
			const gitEnv = createLocalCloneEnvironment(
				root,
				[oldCloneUrl, currentCloneUrl],
				origin,
			);

			try {
				const [, oldName] = oldSlug.split('/') as [string, string];
				expect(
					runStagedCheckout(
						{
							clone_url: oldCloneUrl,
							defaultBranch: 'main',
							folderName: oldFolder,
							id: 321,
							name: oldName,
							slug: oldSlug,
						},
						target,
						7,
						gitEnv,
					).outcome,
				).toBe('added');
				writeFileSync(path.join(source, 'local-change.txt'), 'replace me');
				const [owner, name] = currentSlug.split('/') as [string, string];

				const result = runForcedVerification(
					target,
					{ id: 321, name, owner, slug: currentSlug },
					gitEnv,
					[oldSlug],
				);

				expect(result.exitCode).toBe(0);
				expect(result.checkouts[0]?.name).toBe(currentFolder);
				expect(result.checkouts[0]?.outcome).toBe('updated');
				expect(readdirSync(target)).toContain(currentFolder);
				expect(readdirSync(target)).not.toContain(oldFolder);
				expect(existsSync(path.join(destination, 'local-change.txt'))).toBe(false);
				expect(
					runGit(['config', '--local', '--get', 'starsync.repository-id'], destination),
				).toBe('321');
				expect(
					runGit(['config', '--local', '--get', 'starsync.repository-slug'], destination),
				).toBe(currentSlug);
				expect(
					runGit(['config', '--local', '--get', 'remote.origin.url'], destination),
				).toBe(currentCloneUrl);
			} finally {
				rmSync(root, { force: true, recursive: true });
			}
		},
		// One clone-and-reclone per case costs about 2s on the windows-latest runner against
		// 0.7s on ubuntu, so the budget is stated rather than left to the 5s default.
		10_000,
	);

	test('preserves a renamed source when its stable ID does not match GitHub', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-force-id-mismatch-'));
		const target = path.join(root, 'archive');
		const oldSlug = 'previous/repository';
		const currentSlug = 'example/repository';
		const oldCloneUrl = `https://github.com/${oldSlug}.git`;
		const currentCloneUrl = `https://github.com/${currentSlug}.git`;
		const source = path.join(target, 'repository--previous');
		mkdirSync(target);
		writeManagedArchiveConfig(target);
		const origin = createLocalOrigin(root);
		const gitEnv = createLocalCloneEnvironment(root, [oldCloneUrl, currentCloneUrl], origin);

		try {
			expect(
				runStagedCheckout(
					{
						clone_url: oldCloneUrl,
						defaultBranch: 'main',
						folderName: 'repository--previous',
						id: 321,
						name: 'repository',
						slug: oldSlug,
					},
					target,
					7,
					gitEnv,
				).outcome,
			).toBe('added');
			writeFileSync(path.join(source, 'local-change.txt'), 'keep me');

			const result = runForcedVerification(
				target,
				{ id: 999, name: 'repository', owner: 'example', slug: currentSlug },
				gitEnv,
				[oldSlug],
			);

			expect(result.exitCode).toBe(1);
			expect(
				result.checkouts[0]?.findings.some(
					(finding) => finding.code === 'checkout-reclone-failed',
				),
			).toBe(true);
			expect(existsSync(path.join(source, 'local-change.txt'))).toBe(true);
			expect(existsSync(path.join(target, 'repository--example'))).toBe(false);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('does not force-replace a dirty checkout whose stable ID is duplicated', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-force-duplicate-id-'));
		const target = path.join(root, 'archive');
		const origin = createLocalOrigin(root);
		const repositories = [
			{ folderName: 'first--example', name: 'first', slug: 'example/first' },
			{ folderName: 'second--example', name: 'second', slug: 'example/second' },
		];
		const cloneUrls = repositories.map(({ slug }) => `https://github.com/${slug}.git`);
		const gitEnv = createLocalCloneEnvironment(root, cloneUrls, origin);
		mkdirSync(target);
		writeManagedArchiveConfig(target);

		try {
			for (const [index, repository] of repositories.entries()) {
				expect(
					runStagedCheckout(
						{
							clone_url: cloneUrls[index]!,
							defaultBranch: 'main',
							...repository,
							id: 321,
						},
						target,
						7,
						gitEnv,
					).outcome,
				).toBe('added');
			}
			const dirtyPath = path.join(target, 'first--example', 'local-change.txt');
			writeFileSync(dirtyPath, 'keep me');

			const result = runForcedVerification(
				target,
				{ id: 321, name: 'first', owner: 'example', slug: 'example/first' },
				gitEnv,
			);

			expect(result.exitCode).toBe(1);
			expect(
				result.checkouts.every((checkout) =>
					checkout.findings.some((finding) => finding.code === 'duplicate-identity'),
				),
			).toBe(true);
			expect(
				result.checkouts.some((checkout) =>
					checkout.findings.some((finding) => finding.code === 'checkout-recloned'),
				),
			).toBe(false);
			expect(readFileSync(dirtyPath, 'utf8')).toBe('keep me');
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('preserves a renamed source when the current canonical destination is occupied', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-force-rename-collision-'));
		const target = path.join(root, 'archive');
		const oldSlug = 'previous/repository';
		const currentSlug = 'example/repository';
		const oldCloneUrl = `https://github.com/${oldSlug}.git`;
		const currentCloneUrl = `https://github.com/${currentSlug}.git`;
		const source = path.join(target, 'repository--previous');
		const destination = path.join(target, 'repository--example');
		mkdirSync(target);
		writeManagedArchiveConfig(target);
		const origin = createLocalOrigin(root);
		const gitEnv = createLocalCloneEnvironment(root, [oldCloneUrl, currentCloneUrl], origin);

		try {
			expect(
				runStagedCheckout(
					{
						clone_url: oldCloneUrl,
						defaultBranch: 'main',
						folderName: 'repository--previous',
						id: 321,
						name: 'repository',
						slug: oldSlug,
					},
					target,
					7,
					gitEnv,
				).outcome,
			).toBe('added');
			writeFileSync(path.join(source, 'local-change.txt'), 'keep source');
			mkdirSync(destination);
			writeFileSync(path.join(destination, 'keep.txt'), 'keep destination');

			const result = runForcedVerification(
				target,
				{ id: 321, name: 'repository', owner: 'example', slug: currentSlug },
				gitEnv,
				[oldSlug],
			);

			expect(result.exitCode).toBe(1);
			expect(
				result.checkouts
					.find((checkout) => checkout.name === 'repository--previous')
					?.findings.some(
						(finding) =>
							finding.code === 'checkout-reclone-failed' &&
							finding.message.includes('already occupied'),
					),
			).toBe(true);
			expect(readFileSync(path.join(source, 'local-change.txt'), 'utf8')).toBe('keep source');
			expect(readFileSync(path.join(destination, 'keep.txt'), 'utf8')).toBe(
				'keep destination',
			);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('keeps failed damaged cleanup out of later archive inspection and planning', async () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-damaged-cleanup-'));
		const target = path.join(root, 'archive');
		const destination = path.join(target, 'repository--example');
		const cloneUrl = 'https://github.com/example/repository.git';
		mkdirSync(target);
		writeManagedArchiveConfig(target);
		const origin = createLocalOrigin(root);
		const gitEnv = createLocalCloneEnvironment(root, cloneUrl, origin);

		try {
			expect(
				runStagedCheckout(
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
					gitEnv,
				).outcome,
			).toBe('added');
			writeFileSync(path.join(destination, '.git', 'config'), '\0'.repeat(256));

			const failedCleanup = runForcedVerification(
				target,
				{
					id: 321,
					name: 'repository',
					owner: 'example',
					slug: 'example/repository',
				},
				gitEnv,
				[],
				true,
			);
			const backups = readdirSync(target).filter((name) =>
				name.startsWith(DAMAGED_CHECKOUT_PREFIX),
			);

			expect(failedCleanup.exitCode).toBe(0);
			expect(
				failedCleanup.checkouts[0]?.findings.some(
					(finding) => finding.code === 'damaged-checkout-cleanup-failed',
				),
			).toBe(true);
			expect(backups).toHaveLength(1);
			expect(inspectArchive(target).entries.map((entry) => entry.name)).toEqual([
				'repository--example',
			]);

			const plan = await planManagedSync(target, []);
			expect(plan.blockedReports).toEqual([]);
			expect(plan.retainedReports.map((checkout) => checkout.name)).toEqual([
				'repository--example',
			]);

			const recoveredCleanup = runForcedVerification(
				target,
				{
					id: 321,
					name: 'repository',
					owner: 'example',
					slug: 'example/repository',
				},
				gitEnv,
			);
			expect(
				recoveredCleanup.findings.some(
					(finding) => finding.code === 'owned-checkout-artifact-removed',
				),
			).toBe(true);
			expect(backups.some((name) => existsSync(path.join(target, name)))).toBe(false);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('replaces a canonical checkout whose identity metadata is missing', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-staged-missing-identity-'));
		const target = path.join(root, 'archive');
		const cloneUrl = 'https://github.com/example/repository.git';
		const destination = path.join(target, 'repository--example');
		mkdirSync(target);
		writeManagedArchiveConfig(target);
		const origin = createLocalOrigin(root);
		const gitEnv = createLocalCloneEnvironment(root, cloneUrl, origin);

		try {
			expect(
				runStagedCheckout(
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
					gitEnv,
				).outcome,
			).toBe('added');
			runGit(['config', '--local', '--unset-all', 'starsync.repository-id'], destination);
			runGit(['config', '--local', '--unset-all', 'starsync.repository-slug'], destination);

			const result = runForcedVerification(
				target,
				{
					id: 321,
					name: 'repository',
					owner: 'example',
					slug: 'example/repository',
				},
				gitEnv,
			);

			expect(result.exitCode).toBe(0);
			expect(result.checkouts[0]?.outcome).toBe('updated');
			expect(
				result.checkouts[0]?.findings.some(
					(finding) => finding.code === 'checkout-recloned',
				),
			).toBe(true);
			expect(
				runGit(['config', '--local', '--get', 'starsync.repository-id'], destination),
			).toBe('321');
			expect(
				runGit(['config', '--local', '--get', 'starsync.repository-slug'], destination),
			).toBe('example/repository');
			expect(runGit(['status', '--porcelain'], destination)).toBe('');
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('keeps a damaged checkout when its replacement cannot be cloned', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-staged-replace-failure-'));
		const target = path.join(root, 'archive');
		const destination = path.join(target, 'repository--example');
		const marker = path.join(destination, 'keep.txt');
		mkdirSync(path.join(destination, '.git'), { recursive: true });
		writeFileSync(marker, 'keep');
		writeFileSync(path.join(destination, '.git', 'config'), '\0'.repeat(256));
		writeManagedArchiveConfig(target);

		try {
			const result = runForcedVerification(
				target,
				{
					id: 321,
					name: 'repository',
					owner: 'example',
					slug: 'example/repository',
				},
				createLocalCloneEnvironment(
					root,
					'https://github.com/example/repository.git',
					path.join(root, 'missing.git'),
				),
			);
			const checkout = result.checkouts[0];

			expect(result.exitCode).toBe(1);
			expect(
				checkout?.findings.some((finding) => finding.code === 'checkout-reclone-failed'),
			).toBe(true);
			expect(readFileSync(marker, 'utf8')).toBe('keep');
			expect(
				readdirSync(target).filter(
					(name) =>
						name.startsWith(STAGED_CHECKOUT_PREFIX) ||
						name.startsWith(DAMAGED_CHECKOUT_PREFIX),
				),
			).toEqual([]);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('removes pre-existing StarSync staging directories during forced verification', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'starsync-staged-abandoned-'));
		const target = path.join(root, 'archive');
		const abandoned = path.join(target, `${STAGED_CHECKOUT_PREFIX}ABC123`);
		mkdirSync(path.join(abandoned, '.git'), { recursive: true });
		writeFileSync(path.join(abandoned, '.git', 'config'), '\0'.repeat(256));
		writeManagedArchiveConfig(target);

		try {
			const result = runForcedVerification(
				target,
				{
					id: 321,
					name: 'repository',
					owner: 'example',
					slug: 'example/repository',
				},
				{},
			);

			expect(result.exitCode).toBe(0);
			expect(result.checkouts).toEqual([]);
			expect(
				result.findings.some(
					(finding) => finding.code === 'owned-checkout-artifact-removed',
				),
			).toBe(true);
			expect(existsSync(abandoned)).toBe(false);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test('does not remove similarly prefixed directories without owned suffixes', () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-owned-boundary-'));
		const uncertain = [
			path.join(target, `${STAGED_CHECKOUT_PREFIX}user-directory`),
			path.join(target, `${DAMAGED_CHECKOUT_PREFIX}not-a-uuid`),
		];
		writeManagedArchiveConfig(target);
		for (const directory of uncertain) mkdirSync(directory);
		const acquisition = acquireArchiveLock(target, 'verify');
		if (!acquisition.ok) throw new Error(acquisition.message);
		let releaseError: null | string = null;

		try {
			expect(cleanupOwnedCheckoutArtifacts(target, acquisition.held)).toEqual([]);
		} finally {
			const released = releaseArchiveLock(acquisition.held);
			if (!released.ok) releaseError = released.message;
		}
		expect(releaseError).toBeNull();
		try {
			expect(uncertain.every((directory) => existsSync(directory))).toBe(true);
			expect(inspectArchive(target).entries.map((entry) => entry.path)).toEqual(uncertain);
		} finally {
			rmSync(target, { force: true, recursive: true });
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
				createLocalCloneEnvironment(root, cloneUrl, path.join(root, 'missing.git')),
			);

			expect(result.outcome).toBe('failed');
			expect(readFileSync(marker, 'utf8')).toBe('keep');
			expect(existsSync(path.join(target, 'missing--example'))).toBe(false);
			expect(
				readdirSync(target).filter((name) => name.startsWith(STAGED_CHECKOUT_PREFIX)),
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
				7,
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
				readdirSync(target).filter((name) => name.startsWith(STAGED_CHECKOUT_PREFIX)),
			).toEqual([]);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});
});
