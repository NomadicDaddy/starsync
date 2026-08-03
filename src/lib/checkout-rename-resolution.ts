import type { ArchiveEntry } from './archive-inspection.ts';
import type { RenamePreview } from './reporting.ts';
import type { RepositoryResolver, ResolvedRepository } from './repository-resolution.ts';

import { readCheckoutIdentity } from './checkout-identity.ts';
import { readStatusPaths } from './git-exec.ts';
import { createFinding, type CheckoutReport } from './reporting.ts';
import { parseGitHubRepositorySlug } from './repository-resolution.ts';
import {
	hasEmbeddedCredentials,
	isGitHubDotComUrl,
	sanitizeMessage,
	sanitizeUrl,
} from './secret-safety.ts';
import { areAllPathsUnrepresentable } from './windows-checkout.ts';

export interface ResolvedRenameEntry {
	blockedReason: null | string;
	entry: ArchiveEntry;
	needsOriginUpdate: boolean;
	needsSlugUpdate: boolean;
	preview: RenamePreview;
}

const failedCheckout = (entry: ArchiveEntry, code: string, message: string): CheckoutReport => ({
	findings: [createFinding('error', code, message)],
	lifecycle: entry.isGitCheckout ? 'blocked' : null,
	name: entry.name,
	outcome: 'failed',
	pendingRename: false,
	rename: {
		classification: 'failed',
		proposedName: null,
		repositoryId: null,
		repositorySlug: null,
	},
});

const parseResolvableOrigin = (
	entry: ArchiveEntry,
): { owner: string; repository: string } | CheckoutReport => {
	if (!entry.isGitCheckout) {
		return failedCheckout(
			entry,
			'unrelated-archive-entry',
			'Archive entry is not a Git checkout.',
		);
	}
	if (entry.gitError || !entry.origin) {
		return failedCheckout(
			entry,
			'origin-unverifiable',
			`Cannot read remote.origin.url${entry.gitError ? `: ${entry.gitError}` : '.'}`,
		);
	}
	if (hasEmbeddedCredentials(entry.origin)) {
		return failedCheckout(
			entry,
			'credential-bearing-origin',
			`Remote origin contains embedded credentials: ${sanitizeUrl(entry.origin)}`,
		);
	}
	const slug = isGitHubDotComUrl(entry.origin) ? parseGitHubRepositorySlug(entry.origin) : null;
	return (
		slug ??
		failedCheckout(
			entry,
			'invalid-origin',
			isGitHubDotComUrl(entry.origin)
				? `Cannot parse a GitHub repository slug from ${sanitizeUrl(entry.origin)}`
				: `Remote origin is not GitHub.com: ${sanitizeUrl(entry.origin)}`,
		)
	);
};

const isValidRepository = (repository: ResolvedRepository): boolean =>
	Number.isSafeInteger(repository.id) &&
	repository.id > 0 &&
	Boolean(repository.name) &&
	Boolean(repository.owner) &&
	Boolean(repository.slug) &&
	!/[\\/]/.test(repository.name) &&
	!/[\\/]/.test(repository.owner) &&
	repository.slug.toLowerCase() === `${repository.owner}/${repository.name}`.toLowerCase();

const resolveRepository = async (
	entry: ArchiveEntry,
	slug: { owner: string; repository: string },
	resolver: RepositoryResolver,
): Promise<CheckoutReport | ResolvedRepository> => {
	try {
		const repository = await resolver(slug.owner, slug.repository);
		return isValidRepository(repository)
			? repository
			: failedCheckout(
					entry,
					'invalid-repository-identity',
					'Repository identity response contains invalid or inconsistent fields.',
				);
	} catch (err) {
		return failedCheckout(
			entry,
			'identity-resolution-failed',
			`Cannot resolve repository identity: ${sanitizeMessage(err instanceof Error ? err.message : String(err))}`,
		);
	}
};

const readIdentity = async (
	entry: ArchiveEntry,
): Promise<CheckoutReport | NonNullable<Awaited<ReturnType<typeof readCheckoutIdentity>>>> => {
	try {
		const identity = await readCheckoutIdentity(entry.path);
		return (
			identity ??
			failedCheckout(
				entry,
				'missing-identity-metadata',
				'Format-2 checkouts must already contain stable repository identity metadata.',
			)
		);
	} catch (err) {
		return failedCheckout(
			entry,
			'invalid-identity-metadata',
			`Cannot read managed checkout identity: ${sanitizeMessage(err instanceof Error ? err.message : String(err))}`,
		);
	}
};

const inspectBlockedReason = async (entry: ArchiveEntry): Promise<null | string> => {
	try {
		const paths = await readStatusPaths(['-c', 'core.askPass='], {
			cwd: entry.path,
			env: { GIT_OPTIONAL_LOCKS: '0' },
		});
		return paths.length > 0 && !areAllPathsUnrepresentable(paths)
			? 'Local changes prevent a safe folder rename.'
			: null;
	} catch (err) {
		return `Local state cannot be verified: ${sanitizeMessage(err instanceof Error ? err.message : String(err))}`;
	}
};

export const resolveRenameEntry = async (
	entry: ArchiveEntry,
	resolver: RepositoryResolver,
): Promise<CheckoutReport | ResolvedRenameEntry> => {
	const originSlug = parseResolvableOrigin(entry);
	if ('outcome' in originSlug) return originSlug;
	const repository = await resolveRepository(entry, originSlug, resolver);
	if ('outcome' in repository) return repository;
	const identity = await readIdentity(entry);
	if ('outcome' in identity) return identity;
	if (identity.repositoryId !== repository.id) {
		return failedCheckout(
			entry,
			'repository-identity-mismatch',
			`Stored repository identity ${identity.repositoryId} does not match resolved identity ${repository.id}.`,
		);
	}
	const proposedName = `${repository.name}--${repository.owner}`;
	const needsOriginUpdate =
		`${originSlug.owner}/${originSlug.repository}`.toLowerCase() !==
		repository.slug.toLowerCase();
	const needsSlugUpdate = identity.repositorySlug.toLowerCase() !== repository.slug.toLowerCase();
	const needsFolderRename = entry.name !== proposedName;
	const needsUpdate = needsOriginUpdate || needsSlugUpdate || needsFolderRename;
	return {
		blockedReason: needsUpdate ? await inspectBlockedReason(entry) : null,
		entry,
		needsOriginUpdate,
		needsSlugUpdate,
		preview: {
			classification: needsUpdate ? 'pending' : 'current',
			proposedName,
			repositoryId: repository.id,
			repositorySlug: repository.slug,
		},
	};
};
