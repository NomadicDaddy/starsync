import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ArchiveEntry } from '../src/lib/archive-inspection.ts';
import type { ResolvedRepository } from '../src/lib/repository-resolution.ts';

import { verifyCheckout } from '../src/lib/archive-verification-checkout.ts';
import { resolveRenameEntry } from '../src/lib/checkout-rename-resolution.ts';
import { refreshCheckoutOnDefaultBranch } from '../src/lib/default-branch-refresh.ts';
import { parsePorcelainStatusPaths, readStatusPaths } from '../src/lib/git-exec.ts';
import { isLfsSmudgeFailure } from '../src/lib/git-recovery.ts';
import { classifyTagClobberFailure, describeRetainedTags } from '../src/lib/remote-fetch.ts';
import { materializeExcludedCheckout } from '../src/lib/windows-checkout.ts';

/** Reports as skipped, not passed, on platforms that can represent every path. */
const windowsOnly = test.skipIf(process.platform !== 'win32');

const runGit = (args: string[], cwd: string): string => {
	const result = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		stderr: 'pipe',
		stdin: 'ignore',
		stdout: 'pipe',
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed: ${result.stderr.toString() || result.stdout.toString()}`,
		);
	}
	return result.stdout.toString().trim();
};

const commitInvalidPath = (source: string, invalidPath: string, content: string): void => {
	const blobSource = path.join(source, 'invalid-path-blob');
	writeFileSync(blobSource, content);
	const blob = runGit(['hash-object', '-w', blobSource], source);
	rmSync(blobSource);
	runGit(['config', 'core.protectNTFS', 'false'], source);
	runGit(['update-index', '--add', '--cacheinfo', `100644,${blob},${invalidPath}`], source);
	runGit(['commit', '-m', `record ${invalidPath}`], source);
};

const createOrigin = (root: string, invalidPath?: string): string => {
	const source = path.join(root, 'source');
	const origin = path.join(root, 'origin.git');
	mkdirSync(source);
	runGit(['init', '--initial-branch=main'], source);
	runGit(['config', 'user.email', 'starsync@example.test'], source);
	runGit(['config', 'user.name', 'StarSync Test'], source);
	writeFileSync(path.join(source, 'README.md'), '# initial\n');
	runGit(['add', 'README.md'], source);
	runGit(['commit', '-m', 'initial'], source);
	if (invalidPath !== undefined) commitInvalidPath(source, invalidPath, 'first revision\n');
	runGit(['tag', 'rolling'], source);
	runGit(['clone', '--bare', source, origin], root);
	runGit(['remote', 'add', 'origin', origin], source);
	return origin;
};

const publishUpstreamCommit = (root: string, revision: number, invalidPath?: string): void => {
	const source = path.join(root, 'source');
	writeFileSync(path.join(source, 'README.md'), `# revision ${revision}\n`);
	runGit(['add', 'README.md'], source);
	runGit(['commit', '-m', `revision ${revision}`], source);
	if (invalidPath !== undefined) commitInvalidPath(source, invalidPath, `revision ${revision}\n`);
	runGit(['tag', '--force', 'rolling'], source);
	runGit(['push', 'origin', 'main'], source);
	runGit(['push', '--force', 'origin', 'refs/tags/rolling'], source);
};

/**
 * Recreates the checkout state an earlier StarSync release left behind: the
 * unrepresentable path lives in history but never in the index, so Git reports
 * a staged deletion that can never be resolved.
 */
const stageWithoutUnrepresentablePath = (
	checkout: string,
	origin: string,
	root: string,
	invalidPath: string,
): void => {
	runGit(['clone', '--no-checkout', origin, checkout], root);
	runGit(['-c', 'core.protectNTFS=false', 'read-tree', 'HEAD'], checkout);
	runGit(
		['-c', 'core.protectNTFS=false', 'update-index', '--force-remove', '--', invalidPath],
		checkout,
	);
	runGit(['checkout-index', '--all'], checkout);
};

/** One path per shape of Windows unrepresentability that ADR 0009 names. */
const UNREPRESENTABLE_FIXTURES = [
	{ path: 'screens/localhost:5287.png', sparsePattern: 'screens/localhost:5287.png' },
	{ path: 'notes/history|find|cd.md', sparsePattern: 'notes/history|find|cd.md' },
	{ path: 'docs/trailing space ', sparsePattern: 'docs/trailing space\\ ' },
	{ path: 'docs/two  ', sparsePattern: 'docs/two\\ \\ ' },
	{ path: 'docs/trailing period.', sparsePattern: 'docs/trailing period.' },
	{ path: 'docs/star*name.md', sparsePattern: 'docs/star\\*name.md' },
	{ path: 'docs/[bracket]:file.md', sparsePattern: 'docs/\\[bracket\\]:file.md' },
	{ path: 'docs/back\\slash.md', sparsePattern: 'docs/back\\\\slash.md' },
	{ path: 'nul.txt', sparsePattern: 'nul.txt' },
];

const withTemporaryRoot = async (
	prefix: string,
	body: (root: string) => Promise<void>,
): Promise<void> => {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	try {
		await body(root);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
};

describe('tag clobber classification', () => {
	test('accepts a failure whose only rejections are moved tags', () => {
		const message = [
			'Command failed: git fetch --tags --no-prune origin',
			'From https://github.com/dockur/windows',
			' ! [rejected]        v5.15      -> v5.15  (would clobber existing tag)',
			' ! [rejected]        v6.00      -> v6.00  (would clobber existing tag)',
		].join('\n');

		expect(classifyTagClobberFailure(message)).toEqual(['v5.15', 'v6.00']);
	});

	test('accepts a fetch that also updated branches before the tag rejection', () => {
		const message = [
			'Command failed: git fetch --tags --no-prune origin',
			'From https://github.com/PostHog/posthog',
			'   fa90967825b..5d5ff6b741c master                -> origin/master',
			' * [new branch]      desktop-scope-work -> origin/desktop-scope-work',
			' ! [rejected]        posthog-cli-latest    -> posthog-cli-latest  (would clobber existing tag)',
		].join('\n');

		expect(classifyTagClobberFailure(message)).toEqual(['posthog-cli-latest']);
	});

	test('rejects a failure that also rejected a non-tag reference', () => {
		const message = [
			'Command failed: git fetch --tags --no-prune origin',
			' ! [rejected]        main       -> origin/main  (non-fast-forward)',
			' ! [rejected]        v1.0       -> v1.0  (would clobber existing tag)',
		].join('\n');

		expect(classifyTagClobberFailure(message)).toBeNull();
	});

	test('rejects a failure that reported a fatal error alongside the tag rejection', () => {
		const message = [
			'Command failed: git fetch --tags --no-prune origin',
			' ! [rejected]        v1.0       -> v1.0  (would clobber existing tag)',
			'fatal: could not read from remote repository',
		].join('\n');

		expect(classifyTagClobberFailure(message)).toBeNull();
	});

	test('rejects a failure with no rejections at all', () => {
		expect(classifyTagClobberFailure('Command failed: git fetch\nfatal: not found')).toBeNull();
	});

	test('summarizes retained tags without printing an unbounded list', () => {
		const many = Array.from({ length: 14 }, (_, index) => `v${index}`);

		expect(describeRetainedTags(['nightly'])).toContain('1 tag');
		expect(describeRetainedTags(many)).toContain('and 4 more');
	});
});

describe('git status porcelain parsing', () => {
	test('reads NUL-separated paths without quoting or escaping', () => {
		const output = 'D  alternatives for history|find|cd.md\0 M src/"quoted".ts\0';

		expect(parsePorcelainStatusPaths(output)).toEqual([
			'alternatives for history|find|cd.md',
			'src/"quoted".ts',
		]);
	});

	test('reads both paths of a rename record', () => {
		const output = 'R  new/name.ts\0old/name.ts\0 M other.ts\0';

		expect(parsePorcelainStatusPaths(output)).toEqual([
			'new/name.ts',
			'old/name.ts',
			'other.ts',
		]);
	});

	test('reads an empty status as no paths', () => {
		expect(parsePorcelainStatusPaths('')).toEqual([]);
	});

	test('reads a worktree-only record whose index field is a space', async () => {
		await withTemporaryRoot('starsync-status-paths-', async (root) => {
			const checkout = path.join(root, 'source');
			createOrigin(root);
			writeFileSync(path.join(checkout, 'README.md'), '# edited locally\n');

			expect(await readStatusPaths([], { cwd: checkout })).toEqual(['README.md']);
		});
	});
});

describe('Git LFS failure classification', () => {
	test('recognizes a smudge failure caused by an object upstream no longer serves', () => {
		const message = [
			'Command failed: git clone https://github.com/vercel-labs/webreel.git .starsync-checkout-85etul',
			'Error downloading object: examples/custom-theme/videos/custom-theme.mp4 (fc33f30):',
			'Smudge error: Object does not exist on the server: [404]',
			"error: external filter 'git-lfs filter-process' failed",
			'fatal: examples/custom-theme/videos/custom-theme.mp4: smudge filter lfs failed',
		].join('\n');

		expect(isLfsSmudgeFailure(message)).toBe(true);
	});

	test('leaves an unrelated clone failure alone', () => {
		expect(isLfsSmudgeFailure('fatal: repository not found')).toBe(false);
	});
});

const archiveEntry = (checkout: string): ArchiveEntry => ({
	gitError: null,
	isGitCheckout: true,
	name: path.basename(checkout),
	origin: 'https://github.com/NomadicDaddy/starsync.git',
	path: checkout,
});

const resolveFixtureRepository = (): Promise<ResolvedRepository> =>
	Promise.resolve({
		id: 4242,
		name: 'starsync',
		owner: 'NomadicDaddy',
		slug: 'NomadicDaddy/starsync',
	});

describe('sparse-checkout pattern escaping', () => {
	for (const { path: invalidPath, sparsePattern } of UNREPRESENTABLE_FIXTURES) {
		windowsOnly(`produces a clean checkout for ${JSON.stringify(invalidPath)}`, async () => {
			await withTemporaryRoot('starsync-sparse-pattern-', async (root) => {
				const origin = createOrigin(root, invalidPath);
				const checkout = path.join(root, 'checkout');
				runGit(['clone', '--no-checkout', origin, checkout], root);

				await materializeExcludedCheckout(checkout);

				expect(runGit(['status', '--porcelain'], checkout)).toBe('');
				const sparsePath = runGit(
					['rev-parse', '--git-path', 'info/sparse-checkout'],
					checkout,
				);
				expect(readFileSync(path.resolve(checkout, sparsePath), 'utf8')).toContain(
					`!/${sparsePattern}`,
				);
				expect(runGit(['ls-tree', '-r', '-z', '--name-only', 'HEAD'], checkout)).toContain(
					invalidPath,
				);
				// Trimmed because a host with core.autocrlf enabled writes CRLF here.
				expect(readFileSync(path.join(checkout, 'README.md'), 'utf8').trim()).toBe(
					'# initial',
				);
			});
		});
	}
});

describe('unrepresentable paths in read-only inspection', () => {
	windowsOnly('verify does not call an unrepresentable path a blocked checkout', async () => {
		await withTemporaryRoot('starsync-verify-invalid-path-', async (root) => {
			const invalidPath = 'screens/localhost:5287.png';
			const origin = createOrigin(root, invalidPath);
			const checkout = path.join(root, 'checkout');
			stageWithoutUnrepresentablePath(checkout, origin, root, invalidPath);
			runGit(['config', 'starsync.repository-id', '4242'], checkout);
			runGit(['config', 'starsync.repository-slug', 'NomadicDaddy/starsync'], checkout);

			const clean = await verifyCheckout(archiveEntry(checkout));
			writeFileSync(path.join(checkout, 'README.md'), '# edited locally\n');
			const dirty = await verifyCheckout(archiveEntry(checkout));

			expect(clean.report.findings.map((finding) => finding.code)).not.toContain(
				'checkout-blocked',
			);
			expect(dirty.report.findings.map((finding) => finding.code)).toContain(
				'checkout-blocked',
			);
		});
	});

	windowsOnly('rename does not call an unrepresentable path a blocker', async () => {
		await withTemporaryRoot('starsync-rename-invalid-path-', async (root) => {
			const invalidPath = 'screens/localhost:5287.png';
			const origin = createOrigin(root, invalidPath);
			const checkout = path.join(root, 'checkout');
			stageWithoutUnrepresentablePath(checkout, origin, root, invalidPath);
			runGit(['config', 'starsync.repository-id', '4242'], checkout);
			runGit(['config', 'starsync.repository-slug', 'NomadicDaddy/starsync'], checkout);

			const clean = await resolveRenameEntry(
				archiveEntry(checkout),
				resolveFixtureRepository,
			);
			writeFileSync(path.join(checkout, 'README.md'), '# edited locally\n');
			const dirty = await resolveRenameEntry(
				archiveEntry(checkout),
				resolveFixtureRepository,
			);

			expect(clean).toHaveProperty('blockedReason', null);
			expect(dirty).toHaveProperty(
				'blockedReason',
				'Local changes prevent a safe folder rename.',
			);
		});
	});

	windowsOnly('read-only inspection leaves the checkout untouched', async () => {
		await withTemporaryRoot('starsync-inspection-readonly-', async (root) => {
			const invalidPath = 'screens/localhost:5287.png';
			const origin = createOrigin(root, invalidPath);
			const checkout = path.join(root, 'checkout');
			stageWithoutUnrepresentablePath(checkout, origin, root, invalidPath);
			runGit(['config', 'starsync.repository-id', '4242'], checkout);
			runGit(['config', 'starsync.repository-slug', 'NomadicDaddy/starsync'], checkout);
			const before = runGit(['status', '--porcelain'], checkout);

			await verifyCheckout(archiveEntry(checkout));
			await resolveRenameEntry(archiveEntry(checkout), resolveFixtureRepository);

			expect(runGit(['status', '--porcelain'], checkout)).toBe(before);
		});
	});
});

describe('default branch refresh resilience', () => {
	test('advances the checkout and keeps the archived target of a moved tag', async () => {
		await withTemporaryRoot('starsync-tag-clobber-', async (root) => {
			const origin = createOrigin(root);
			const checkout = path.join(root, 'checkout');
			runGit(['clone', origin, checkout], root);
			const archivedTag = runGit(['rev-parse', 'rolling^{commit}'], checkout);
			publishUpstreamCommit(root, 2);

			const result = await refreshCheckoutOnDefaultBranch(checkout, 'checkout', 'main');

			expect(result.outcome).toBe('updated');
			expect(result.message).toContain('rolling');
			expect(runGit(['rev-parse', 'rolling^{commit}'], checkout)).toBe(archivedTag);
			expect(runGit(['rev-parse', 'HEAD'], checkout)).toBe(
				runGit(['rev-parse', 'refs/remotes/origin/main'], checkout),
			);
			expect(runGit(['status', '--porcelain'], checkout)).toBe('');
		});
	});

	test('still blocks a checkout that holds real local changes', async () => {
		await withTemporaryRoot('starsync-local-changes-', async (root) => {
			const origin = createOrigin(root);
			const checkout = path.join(root, 'checkout');
			runGit(['clone', origin, checkout], root);
			publishUpstreamCommit(root, 2);
			writeFileSync(path.join(checkout, 'README.md'), '# edited locally\n');

			const result = await refreshCheckoutOnDefaultBranch(checkout, 'checkout', 'main');

			expect(result.outcome).toBe('blocked');
			expect(result.message).toContain('Local changes detected');
		});
	});

	windowsOnly('refreshes a checkout whose paths this platform cannot represent', async () => {
		await withTemporaryRoot('starsync-invalid-path-', async (root) => {
			const invalidPath = 'screens/localhost:5287.png';
			const origin = createOrigin(root, invalidPath);
			const checkout = path.join(root, 'checkout');
			stageWithoutUnrepresentablePath(checkout, origin, root, invalidPath);
			expect(runGit(['status', '--porcelain'], checkout)).not.toBe('');
			publishUpstreamCommit(root, 2, invalidPath);

			const result = await refreshCheckoutOnDefaultBranch(checkout, 'checkout', 'main');

			expect(result.outcome).toBe('updated');
			expect(runGit(['status', '--porcelain'], checkout)).toBe('');
			expect(runGit(['rev-parse', 'HEAD'], checkout)).toBe(
				runGit(['rev-parse', 'refs/remotes/origin/main'], checkout),
			);
			expect(runGit(['ls-tree', '-r', '--name-only', 'HEAD'], checkout)).toContain(
				invalidPath,
			);
			expect(runGit(['ls-files', '-v', '--', invalidPath], checkout)).toBe(
				`S ${invalidPath}`,
			);
		});
	});

	windowsOnly('keeps refreshing an unrepresentable-path checkout on later runs', async () => {
		await withTemporaryRoot('starsync-invalid-path-repeat-', async (root) => {
			const invalidPath = 'screens/localhost:5287.png';
			const origin = createOrigin(root, invalidPath);
			const checkout = path.join(root, 'checkout');
			stageWithoutUnrepresentablePath(checkout, origin, root, invalidPath);
			publishUpstreamCommit(root, 2, invalidPath);
			const first = await refreshCheckoutOnDefaultBranch(checkout, 'checkout', 'main');
			expect(first.outcome).toBe('updated');
			publishUpstreamCommit(root, 3, invalidPath);

			const result = await refreshCheckoutOnDefaultBranch(checkout, 'checkout', 'main');

			expect(result.outcome).toBe('updated');
			expect(runGit(['status', '--porcelain'], checkout)).toBe('');
			expect(runGit(['ls-files', '-v', '--', invalidPath], checkout)).toBe(
				`S ${invalidPath}`,
			);
		});
	});
});
