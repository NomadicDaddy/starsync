import fs from 'node:fs';
import path from 'node:path';

import type { ArchiveHost } from './archive-host.ts';
import type { ManagedCheckout } from './managed-checkout-planning.ts';
import type { CheckoutReport } from './reporting.ts';

import { readCheckoutIdentity } from './checkout-identity.ts';
import { sameFilesystemEntry } from './filesystem-identity.ts';
import { runGit } from './git-exec.ts';
import { blockedCheckoutReport } from './managed-checkout-classification.ts';
import { parseGitHubRepositorySlug } from './repository-resolution.ts';
import {
	hasEmbeddedCredentials,
	isArchiveHostUrl,
	sanitizeMessage,
	sanitizeUrl,
} from './secret-safety.ts';

export interface ManagedCheckoutInspection {
	checkout: ManagedCheckout | null;
	report: CheckoutReport | null;
}

export interface ManagedCheckoutScan {
	checkouts: ManagedCheckout[];
	reports: CheckoutReport[];
}

const emptyInspection = (): ManagedCheckoutInspection => ({ checkout: null, report: null });

/**
 * The operating system's canonical form of an existing path. The native call expands a Windows
 * 8.3 short name (such as RUNNER~1) to its long form, which is the form Git reports, and gives each
 * name in the letter case it has on disk. Node's JavaScript realpath keeps the short name, so an
 * archive named by its short path would refuse its own checkouts. Canonical forms are compared
 * exactly: folding case would treat two directories that differ only in case as one.
 */
const canonicalPath = (target: string): string => fs.realpathSync.native(target);

const lstatIfPresent = (entryPath: string): fs.Stats | undefined =>
	fs.lstatSync(entryPath, { throwIfNoEntry: false });

const gitMetadataProblem = (checkoutPath: string): null | string => {
	const gitEntry = lstatIfPresent(path.join(checkoutPath, '.git'));
	if (gitEntry === undefined) return null;
	if (gitEntry.isSymbolicLink() || !gitEntry.isDirectory()) {
		return 'Its .git entry is a file or link, which can point Git at metadata outside the checkout.';
	}
	if (lstatIfPresent(path.join(checkoutPath, '.git', 'commondir')) !== undefined) {
		return 'Its Git metadata names a common directory, which can point Git outside the checkout.';
	}
	return null;
};

/**
 * Why an archive entry can't be trusted to keep Git work inside the archive, or null when it is a
 * real directory directly under the canonical archive root whose Git metadata, if it has any, is
 * its own `.git` directory. A link or junction in its place, a `.git` file or link, and a
 * `commondir` redirect all count, because sync and rename would otherwise fetch, write identity
 * metadata or move files outside the selected archive. An entry that is neither a directory nor a
 * link is not a checkout, so it has no problem here.
 */
export const checkoutBoundaryProblem = (targetPath: string, name: string): null | string => {
	const checkoutPath = path.join(targetPath, name);
	try {
		const entry = lstatIfPresent(checkoutPath);
		if (entry === undefined) return null;
		if (entry.isSymbolicLink()) {
			return 'The entry is a link or junction. StarSync manages only real directories inside the archive.';
		}
		if (!entry.isDirectory()) return null;
		const canonical = path.join(canonicalPath(targetPath), name);
		if (canonicalPath(checkoutPath) !== canonical) {
			return 'The entry resolves outside the archive root.';
		}
		return gitMetadataProblem(checkoutPath);
	} catch (err) {
		return `Cannot confirm the entry stays inside the archive: ${sanitizeMessage(
			err instanceof Error ? err.message : String(err),
		)}`;
	}
};

/** Git's own answer for where a checkout's work tree, Git directory and common directory are. */
export const GIT_BOUNDARY_QUERY = [
	'rev-parse',
	'--path-format=absolute',
	'--show-toplevel',
	'--git-dir',
	'--git-common-dir',
];

export const GIT_OUTSIDE_CHECKOUT =
	'Git resolves its work tree, Git directory or common directory outside the checkout.';

/**
 * Whether Git's answer to GIT_BOUNDARY_QUERY names the checkout and its own .git directory. Each
 * path must be the same filesystem entry, so an alias of the checkout (a short path, another
 * spelling of a case-insensitive name) passes, while a sibling whose name differs only in case is
 * refused. A path Git names that doesn't exist, such as a work tree redirected to a missing
 * folder, can't be identified, so it still counts as outside the checkout.
 */
export const gitPathsInside = (answer: string, checkoutPath: string): boolean => {
	const [topLevel, gitDir, commonDir, extra] = answer.split(/\r?\n/);
	if (!topLevel || !gitDir || !commonDir || extra !== undefined) return false;
	const metadata = path.join(checkoutPath, '.git');
	return (
		sameFilesystemEntry(topLevel, checkoutPath) &&
		sameFilesystemEntry(gitDir, metadata) &&
		sameFilesystemEntry(commonDir, metadata)
	);
};

/**
 * The full boundary check for an entry about to have Git work done in it: the filesystem check,
 * then Git's own answer for its work tree, Git directory and common directory, read under the
 * shared isolated Git environment. Each must be the checkout or its own .git directory, so a
 * core.worktree setting or any other redirect Git honours is refused before Git reads identity,
 * fetches or writes metadata there. An entry Git can't answer for is refused too.
 */
export const checkoutGitBoundaryProblem = async (
	targetPath: string,
	name: string,
): Promise<null | string> => {
	const fileProblem = checkoutBoundaryProblem(targetPath, name);
	const checkoutPath = path.join(targetPath, name);
	if (fileProblem !== null || !fs.existsSync(path.join(checkoutPath, '.git'))) return fileProblem;
	let answer: string;
	try {
		answer = await runGit(GIT_BOUNDARY_QUERY, { cwd: checkoutPath });
	} catch (err) {
		return `Cannot confirm Git stays inside the checkout: ${sanitizeMessage(
			err instanceof Error ? err.message : String(err),
		)}`;
	}
	return gitPathsInside(answer, checkoutPath) ? null : GIT_OUTSIDE_CHECKOUT;
};

const originMatchesIdentity = (
	origin: string,
	repositorySlug: string,
	host: ArchiveHost,
): boolean => {
	if (hasEmbeddedCredentials(origin)) return false;
	if (!isArchiveHostUrl(origin, host)) return false;
	const originSlug = parseGitHubRepositorySlug(origin, host);
	if (originSlug === null) return false;
	return (
		`${originSlug.owner}/${originSlug.repository}`.toLowerCase() ===
		repositorySlug.toLowerCase()
	);
};

const inspectGitCheckout = async (
	checkoutPath: string,
	name: string,
	host: ArchiveHost,
): Promise<ManagedCheckoutInspection> => {
	const identity = await readCheckoutIdentity(checkoutPath);
	if (identity === null) {
		return {
			checkout: null,
			report: blockedCheckoutReport(
				name,
				'missing-identity-metadata',
				'Format-2 managed checkout has no stable repository identity. A canonical checkout can be safely rebuilt with verify --force.',
			),
		};
	}
	const origin = await runGit(['config', '--local', '--get', 'remote.origin.url'], {
		cwd: checkoutPath,
	});
	if (!originMatchesIdentity(origin, identity.repositorySlug, host)) {
		return {
			checkout: null,
			report: blockedCheckoutReport(
				name,
				'identity-origin-mismatch',
				`Managed checkout identity does not match origin ${sanitizeUrl(origin)}.`,
			),
		};
	}
	return { checkout: { name, ...identity }, report: null };
};

export const inspectManagedCheckoutEntry = async (
	targetPath: string,
	name: string,
	host: ArchiveHost = 'github.com',
): Promise<ManagedCheckoutInspection> => {
	const boundaryProblem = await checkoutGitBoundaryProblem(targetPath, name);
	if (boundaryProblem !== null) {
		return {
			checkout: null,
			report: blockedCheckoutReport(name, 'checkout-outside-archive', boundaryProblem),
		};
	}
	const checkoutPath = path.join(targetPath, name);
	if (!fs.existsSync(path.join(checkoutPath, '.git'))) return emptyInspection();
	try {
		return await inspectGitCheckout(checkoutPath, name, host);
	} catch (err) {
		return {
			checkout: null,
			report: blockedCheckoutReport(
				name,
				'invalid-identity-metadata',
				`Cannot read managed checkout identity: ${sanitizeMessage(
					err instanceof Error ? err.message : String(err),
				)}`,
			),
		};
	}
};

export const filterDuplicateCheckoutIdentities = (
	checkouts: ManagedCheckout[],
): ManagedCheckoutScan => {
	const counts = new Map<number, number>();
	for (const checkout of checkouts) {
		counts.set(checkout.repositoryId, (counts.get(checkout.repositoryId) ?? 0) + 1);
	}
	const unique: ManagedCheckout[] = [];
	const reports: CheckoutReport[] = [];
	for (const checkout of checkouts) {
		if ((counts.get(checkout.repositoryId) ?? 0) === 1) {
			unique.push(checkout);
			continue;
		}
		reports.push(
			blockedCheckoutReport(
				checkout.name,
				'duplicate-identity',
				`Repository identity ${checkout.repositoryId} is used by more than one checkout.`,
			),
		);
	}
	return { checkouts: unique, reports };
};
