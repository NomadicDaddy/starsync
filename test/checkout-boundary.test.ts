import { dlopen, FFIType, ptr } from 'bun:ffi';
import { afterEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CheckoutReport } from '../src/lib/reporting.ts';
import type { RepositoryResolver } from '../src/lib/repository-resolution.ts';

import { writeArchiveConfig } from '../src/lib/archive-config.ts';
import { inspectArchive } from '../src/lib/archive-inspection.ts';
import { verifyCheckout } from '../src/lib/archive-verification-checkout.ts';
import { applyCheckoutRename } from '../src/lib/checkout-rename-apply.ts';
import { resolveRenameEntry } from '../src/lib/checkout-rename-resolution.ts';
import { sameFilesystemEntry } from '../src/lib/filesystem-identity.ts';
import { readStatusPaths } from '../src/lib/git-exec.ts';
import {
	checkoutBoundaryProblem,
	checkoutGitBoundaryProblem,
	gitPathsInside,
} from '../src/lib/managed-checkout-inspection.ts';
import { scanManagedCheckouts } from '../src/lib/managed-checkout-planning.ts';
import { processRepository } from '../src/lib/refresh-existing.ts';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const git = (cwd: string, args: string[]): void => {
	const result = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd,
		stderr: 'pipe',
		stdout: 'pipe',
		windowsHide: true,
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
};

/**
 * An initialized archive with one real checkout, beside a repository outside it. `link` adds a
 * junction (a directory symlink off Windows) named `linked` inside the archive that points at the
 * outside repository, which is the shape the boundary must refuse.
 */
const fixture = (): { archive: string; outside: string; outsideConfig: string } => {
	const root = mkdtempSync(path.join(tmpdir(), 'starsync-boundary-'));
	roots.push(root);
	const archive = path.join(root, 'archive');
	const outside = path.join(root, 'outside');
	mkdirSync(archive);
	writeArchiveConfig(archive, { id: 7, login: 'some-user' });
	mkdirSync(path.join(archive, 'real'));
	mkdirSync(outside);
	git(path.join(archive, 'real'), ['init', '--quiet']);
	git(outside, ['init', '--quiet']);
	git(outside, ['config', 'starsync.repository-id', '1']);
	return { archive, outside, outsideConfig: path.join(outside, '.git', 'config') };
};

const link = (archive: string, outside: string): void => {
	symlinkSync(outside, path.join(archive, 'linked'), 'junction');
};

/**
 * Makes an empty directory hold names that differ only in letter case, as two distinct entries.
 * Windows needs its per-directory case-sensitivity attribute, which `fsutil` sets without
 * elevation; Linux filesystems are case-sensitive already. Returns false where neither holds, such
 * as macOS's default case-insensitive volume.
 */
const makeCaseSensitive = (directory: string): boolean => {
	if (process.platform === 'win32') {
		const result = Bun.spawnSync({
			cmd: ['fsutil', 'file', 'setCaseSensitiveInfo', directory, 'enable'],
			stderr: 'pipe',
			stdout: 'pipe',
			windowsHide: true,
		});
		if (result.exitCode !== 0) return false;
	}
	mkdirSync(path.join(directory, 'case-probe'));
	const distinct = !existsSync(path.join(directory, 'CASE-PROBE'));
	rmSync(path.join(directory, 'case-probe'), { force: true, recursive: true });
	return distinct;
};

const caseVariantsAvailable = ((): boolean => {
	const probe = mkdtempSync(path.join(tmpdir(), 'starsync-case-probe-'));
	try {
		return makeCaseSensitive(probe);
	} finally {
		rmSync(probe, { force: true, recursive: true });
	}
})();

// Whether a fresh temporary directory treats names that differ only in case as one entry.
const caseInsensitiveByDefault = ((): boolean => {
	const probe = mkdtempSync(path.join(tmpdir(), 'starsync-case-default-'));
	try {
		mkdirSync(path.join(probe, 'name'));
		return existsSync(path.join(probe, 'NAME'));
	} finally {
		rmSync(probe, { force: true, recursive: true });
	}
})();

const MAX_WINDOWS_PATH = 32_768;

/**
 * The Windows 8.3 short form of an existing path, from the system's own GetShortPathNameW with the
 * path passed as data, or null off Windows or when no component of the path has a short alias.
 */
const shortPathOf = (target: string): null | string => {
	if (process.platform !== 'win32') return null;
	const kernel32 = dlopen('kernel32.dll', {
		GetShortPathNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
	});
	try {
		const input = Buffer.from(`${target}\0`, 'utf16le');
		const output = Buffer.alloc(MAX_WINDOWS_PATH * 2);
		const length = kernel32.symbols.GetShortPathNameW(
			ptr(input),
			ptr(output),
			MAX_WINDOWS_PATH,
		);
		if (length === 0 || length >= MAX_WINDOWS_PATH) return null;
		const short = output.toString('utf16le', 0, length * 2);
		return short === target ? null : short;
	} finally {
		kernel32.close();
	}
};

// Volumes can have short-name generation turned off, so the short-path test runs only where a
// long folder name actually has a short alias.
const shortNamesAvailable = ((): boolean => {
	if (process.platform !== 'win32') return false;
	const probe = mkdtempSync(path.join(tmpdir(), 'starsync-shortname-probe-'));
	try {
		return shortPathOf(probe) !== null;
	} finally {
		rmSync(probe, { force: true, recursive: true });
	}
})();

describe('checkout boundary', () => {
	test('accepts a real checkout with its own .git directory, and non-checkouts', () => {
		const { archive } = fixture();
		writeFileSync(path.join(archive, 'notes.txt'), 'not a checkout\n');
		expect(checkoutBoundaryProblem(archive, 'real')).toBeNull();
		expect(checkoutBoundaryProblem(archive, 'notes.txt')).toBeNull();
		expect(checkoutBoundaryProblem(archive, 'absent')).toBeNull();
	});

	test('refuses a link or junction in place of a checkout', () => {
		const { archive, outside } = fixture();
		link(archive, outside);
		expect(checkoutBoundaryProblem(archive, 'linked')).toContain('link or junction');
	});

	test('refuses a .git file that redirects Git, and a common-directory redirect', () => {
		const { archive, outside } = fixture();
		mkdirSync(path.join(archive, 'redirected'));
		writeFileSync(path.join(archive, 'redirected', '.git'), `gitdir: ${outside}/.git\n`);
		expect(checkoutBoundaryProblem(archive, 'redirected')).toContain('.git entry');
		writeFileSync(path.join(archive, 'real', '.git', 'commondir'), `${outside}/.git\n`);
		expect(checkoutBoundaryProblem(archive, 'real')).toContain('common directory');
	});

	test('sync lists a linked name as occupied and blocks it', async () => {
		const { archive, outside } = fixture();
		link(archive, outside);
		const scan = await scanManagedCheckouts(archive);
		expect(scan.names).toContain('linked');
		expect(
			scan.reports.map((report) => [report.name, report.findings[0]?.code]),
		).toContainEqual(['linked', 'checkout-outside-archive']);
	});

	test('sync processing fails a linked checkout and leaves the metadata it points to alone', async () => {
		const { archive, outside, outsideConfig } = fixture();
		link(archive, outside);
		const before = readFileSync(outsideConfig, 'utf8');
		const result = await processRepository(
			{
				clone_url: 'https://github.com/example/linked.git',
				defaultBranch: 'main',
				id: 1,
				name: 'linked',
				slug: 'example/linked',
			},
			archive,
			() => false,
			{ archiveOwnerId: 7 },
		);
		expect(result.outcome).toBe('failed');
		expect(result.message).toContain('link or junction');
		expect(readFileSync(outsideConfig, 'utf8')).toBe(before);
		expect(existsSync(path.join(outside, '.git', 'FETCH_HEAD'))).toBe(false);
	});

	test('verification and rename refuse an entry that resolves outside the archive', async () => {
		const { archive, outside } = fixture();
		link(archive, outside);
		const entry = inspectArchive(archive).entries.find(
			(candidate) => candidate.name === 'linked',
		);
		expect(entry?.boundaryError).toContain('link or junction');
		if (entry === undefined) return;
		const verified = await verifyCheckout(entry);
		expect(verified.report.findings.map((finding) => finding.code)).toEqual([
			'checkout-outside-archive',
		]);
		const resolver: RepositoryResolver = () => {
			throw new Error('A refused entry must not reach the repository API.');
		};
		const renamed = await resolveRenameEntry(entry, resolver);
		expect('outcome' in renamed ? renamed.findings.map((finding) => finding.code) : []).toEqual(
			['checkout-outside-archive'],
		);
	});
});

describe('Git effective-path boundary', () => {
	const outsideMessage = 'outside the checkout';

	test('refuses a work tree that core.worktree redirects outside the checkout', async () => {
		const { archive, outside } = fixture();
		const real = path.join(archive, 'real');
		expect(await checkoutGitBoundaryProblem(archive, 'real')).toBeNull();
		git(real, ['config', 'core.worktree', outside]);
		expect(checkoutBoundaryProblem(archive, 'real')).toBeNull();
		expect(await checkoutGitBoundaryProblem(archive, 'real')).toContain(outsideMessage);
	});

	test.skipIf(!caseVariantsAvailable)(
		'refuses a work tree redirected to a sibling whose name differs only in case',
		async () => {
			const root = mkdtempSync(path.join(tmpdir(), 'starsync-case-boundary-'));
			roots.push(root);
			const archive = path.join(root, 'archive');
			mkdirSync(archive);
			if (!makeCaseSensitive(archive)) throw new Error('Case sensitivity was not applied.');
			writeArchiveConfig(archive, { id: 7, login: 'some-user' });
			const real = path.join(archive, 'real');
			const sibling = path.join(archive, 'REAL');
			mkdirSync(real);
			mkdirSync(sibling);
			git(real, ['init', '--quiet']);
			git(sibling, ['init', '--quiet']);
			expect(existsSync(path.join(sibling, '.git'))).toBe(true);
			expect(await checkoutGitBoundaryProblem(archive, 'real')).toBeNull();

			git(real, ['config', 'core.worktree', sibling]);
			expect(checkoutBoundaryProblem(archive, 'real')).toBeNull();
			expect(await checkoutGitBoundaryProblem(archive, 'real')).toContain(outsideMessage);
			const metadata = path.join(sibling, '.git');
			expect(gitPathsInside([sibling, metadata, metadata].join('\n'), real)).toBe(false);
		},
	);

	test.skipIf(!caseInsensitiveByDefault)(
		'accepts Git naming the checkout in another letter case on a case-insensitive volume',
		() => {
			const { archive } = fixture();
			const real = path.join(archive, 'real');
			const respelled = path.join(archive, 'REAL');
			const metadata = path.join(respelled, '.GIT');
			expect(gitPathsInside([respelled, metadata, metadata].join('\n'), real)).toBe(true);
		},
	);

	test('never treats a missing path as the checkout', () => {
		const { archive } = fixture();
		const real = path.join(archive, 'real');
		const missing = path.join(archive, 'missing');
		expect(sameFilesystemEntry(real, real)).toBe(true);
		expect(sameFilesystemEntry(missing, missing)).toBe(false);
		const metadata = path.join(real, '.git');
		expect(gitPathsInside([missing, metadata, metadata].join('\n'), real)).toBe(false);
	});

	test('sync blocks and skips a checkout whose work tree Git resolves elsewhere', async () => {
		const { archive, outside } = fixture();
		git(path.join(archive, 'real'), ['config', 'core.worktree', outside]);
		const scan = await scanManagedCheckouts(archive);
		expect(
			scan.reports.map((report) => [report.name, report.findings[0]?.code]),
		).toContainEqual(['real', 'checkout-outside-archive']);
		const result = await processRepository(
			{
				clone_url: 'https://github.com/example/real.git',
				defaultBranch: 'main',
				id: 1,
				name: 'real',
				slug: 'example/real',
			},
			archive,
			() => false,
			{ archiveOwnerId: 7 },
		);
		expect(result.outcome).toBe('failed');
		expect(result.message).toContain(outsideMessage);
	});

	test('rename apply rechecks the checkout instead of trusting the preview', async () => {
		const { archive, outside } = fixture();
		const real = path.join(archive, 'real');
		const entries = inspectArchive(archive).entries;
		git(real, ['config', 'core.worktree', outside]);
		const checkout: CheckoutReport = {
			findings: [],
			lifecycle: 'active',
			name: 'real',
			outcome: 'current',
			pendingRename: true,
			rename: {
				classification: 'pending',
				proposedName: 'repository--owner',
				repositoryId: 42,
				repositorySlug: 'owner/repository',
			},
		};
		const applied = await applyCheckoutRename(archive, checkout, entries);
		expect(applied.applied).toBe(false);
		expect(applied.report.findings[0]?.message).toContain(outsideMessage);
		expect(existsSync(real)).toBe(true);
		expect(existsSync(path.join(archive, 'repository--owner'))).toBe(false);
	});

	test('inspection asks Git before reading origin, and verification refuses a redirect', async () => {
		const { archive, outside } = fixture();
		const real = path.join(archive, 'real');
		git(real, ['remote', 'add', 'origin', 'https://github.com/owner/repository.git']);
		git(real, ['config', 'core.worktree', outside]);
		const entry = inspectArchive(archive).entries.find(
			(candidate) => candidate.name === 'real',
		);
		expect(entry?.boundaryError).toContain(outsideMessage);
		expect(entry?.origin).toBeNull();
		if (entry === undefined) return;
		const verified = await verifyCheckout(entry);
		expect(verified.report.findings.map((finding) => finding.code)).toEqual([
			'checkout-outside-archive',
		]);
	});

	// The guard itself is checked through the instrumented adapter in test/index.test.ts. This keeps
	// the ordinary regression: a real dirty checkout is still reported as dirty.
	test('status, verify and rename preview still report an ordinary dirty checkout', async () => {
		const { archive } = fixture();
		const real = path.join(archive, 'real');
		git(real, ['remote', 'add', 'origin', 'https://github.com/owner/repository.git']);
		git(real, ['config', 'starsync.repository-id', '42']);
		git(real, ['config', 'starsync.repository-slug', 'owner/repository']);
		writeFileSync(path.join(real, 'notes.txt'), 'one\n');
		git(real, ['add', 'notes.txt']);
		git(real, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
		writeFileSync(path.join(real, 'notes.txt'), 'two\n');
		expect(await readStatusPaths([], { cwd: real })).toEqual(['notes.txt']);
		const entry = inspectArchive(archive).entries.find(
			(candidate) => candidate.name === 'real',
		);
		if (entry === undefined) throw new Error('The fixture checkout is missing.');
		const verified = await verifyCheckout(entry);
		expect(verified.report.findings.map((finding) => finding.code)).toContain(
			'checkout-blocked',
		);
		const resolver: RepositoryResolver = () =>
			Promise.resolve({
				id: 42,
				name: 'repository',
				owner: 'owner',
				slug: 'owner/repository',
			});
		expect(await resolveRenameEntry(entry, resolver)).toHaveProperty(
			'blockedReason',
			'Local changes prevent a safe folder rename.',
		);
	});

	test('a checkout Git cannot open is read no further and kept from forced repair', async () => {
		const { archive } = fixture();
		writeFileSync(path.join(archive, 'real', '.git', 'HEAD'), 'not a ref\n');
		const entry = inspectArchive(archive).entries.find(
			(candidate) => candidate.name === 'real',
		);
		expect(entry?.boundaryUnverified).not.toBeNull();
		expect(entry?.origin).toBeNull();
		if (entry === undefined) return;
		const verified = await verifyCheckout(entry);
		expect(verified.report.findings.map((finding) => finding.code)).toEqual([
			'checkout-boundary-unverified',
		]);
	});

	test.skipIf(!shortNamesAvailable)(
		'accepts an archive named by its Windows short path',
		async () => {
			const { archive } = fixture();
			const real = path.join(archive, 'real');
			git(real, ['remote', 'add', 'origin', 'https://github.com/owner/repository.git']);
			git(real, ['config', 'starsync.repository-id', '42']);
			git(real, ['config', 'starsync.repository-slug', 'owner/repository']);
			writeFileSync(path.join(real, 'notes.txt'), 'one\n');
			git(real, ['add', 'notes.txt']);
			git(real, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
			const short = shortPathOf(archive);
			if (short === null) throw new Error('The fixture archive has no short path.');
			expect(short).toContain('~');
			expect(checkoutBoundaryProblem(short, 'real')).toBeNull();
			expect(await checkoutGitBoundaryProblem(short, 'real')).toBeNull();

			const verifyThrough = async (archivePath: string): Promise<CheckoutReport> => {
				const entry = inspectArchive(archivePath).entries.find(
					(candidate) => candidate.name === 'real',
				);
				if (entry === undefined) throw new Error('The fixture checkout is missing.');
				expect(entry.boundaryError).toBeNull();
				expect(entry.boundaryUnverified).toBeNull();
				return (await verifyCheckout(entry)).report;
			};
			// Through the short path, verify reaches the ordinary checkout checks and reports
			// exactly what it reports through the long path.
			const viaShort = await verifyThrough(short);
			expect(viaShort.outcome).toBe('current');
			expect(viaShort.findings.map((finding) => finding.code)).toEqual([
				'git-integrity-valid',
				'pending-rename',
			]);
			expect(viaShort).toEqual(await verifyThrough(archive));
		},
	);
});
