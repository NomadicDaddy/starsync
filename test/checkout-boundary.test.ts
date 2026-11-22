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
import {
	checkoutBoundaryProblem,
	checkoutGitBoundaryProblem,
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

	test('a checkout Git cannot open is read no further and reported replaceable', async () => {
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
			'git-integrity-failed',
		]);
	});
});
