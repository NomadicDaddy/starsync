import { Octokit } from '@octokit/rest';
import { execFileSync } from 'node:child_process';

import type { ArchiveEntry, RepositoryResolver, ResolvedRepository } from './archive-migration.ts';
import type { CheckoutReport, MigrationPreview } from './reporting.ts';

import { withApiRetry } from './api-retry.ts';
import { buildGitEnvironment, parsePorcelainStatusPaths } from './git-exec.ts';
import { createFinding } from './reporting.ts';
import {
	hasEmbeddedCredentials,
	isGitHubDotComUrl,
	sanitizeMessage,
	sanitizeUrl,
} from './secret-safety.ts';
import { areAllPathsUnrepresentable } from './windows-checkout.ts';

export interface ResolvedEntry {
	blockedReason: null | string;
	entry: ArchiveEntry;
	preview: MigrationPreview;
}

const readMigrationGitRaw = (checkoutPath: string, args: string[]): string =>
	execFileSync('git', ['-c', 'core.askPass=', ...args], {
		cwd: checkoutPath,
		encoding: 'utf-8',
		env: buildGitEnvironment(process.env, { GIT_OPTIONAL_LOCKS: '0' }),
		stdio: ['ignore', 'pipe', 'pipe'],
	});

export const readMigrationGit = (checkoutPath: string, args: string[]): string =>
	readMigrationGitRaw(checkoutPath, args).trim();

const failedCheckout = (entry: ArchiveEntry, code: string, message: string): CheckoutReport => ({
	findings: [createFinding('error', code, message)],
	lifecycle: entry.isGitCheckout ? 'blocked' : null,
	migration: {
		classification: 'failed',
		proposedName: null,
		repositoryId: null,
		repositorySlug: null,
	},
	name: entry.name,
	outcome: 'failed',
	pendingRename: false,
});

export const parseGitHubRepositorySlug = (
	origin: string
): { owner: string; repository: string } | null => {
	const sanitized = sanitizeUrl(origin);
	let pathname: string;
	if (/^https?:\/\//i.test(sanitized) || /^ssh:\/\//i.test(sanitized)) {
		try {
			const parsed = new URL(sanitized);
			if (parsed.search || parsed.hash) return null;
			pathname = parsed.pathname;
		} catch {
			return null;
		}
	} else {
		const match = sanitized.match(/^git@[^:]+:(.+)$/i);
		if (!match?.[1]) return null;
		pathname = match[1];
	}
	const parts = pathname
		.replace(/^\/+/, '')
		.replace(/\.git$/i, '')
		.split('/')
		.filter(Boolean);
	return parts.length === 2 && parts[0] && parts[1]
		? { owner: parts[0], repository: parts[1] }
		: null;
};

const parseResolvableOrigin = (
	entry: ArchiveEntry
): { owner: string; repository: string } | CheckoutReport => {
	if (!entry.isGitCheckout) {
		return failedCheckout(
			entry,
			'unrelated-archive-entry',
			'Archive entry is not a Git checkout.'
		);
	}
	if (entry.gitError || !entry.origin) {
		return failedCheckout(
			entry,
			'origin-unverifiable',
			`Cannot read remote.origin.url${entry.gitError ? `: ${entry.gitError}` : '.'}`
		);
	}
	if (hasEmbeddedCredentials(entry.origin)) {
		return failedCheckout(
			entry,
			'credential-bearing-origin',
			`Remote origin contains embedded credentials: ${sanitizeUrl(entry.origin)}`
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
				: `Remote origin is not GitHub.com: ${sanitizeUrl(entry.origin)}`
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

const resolveRepositoryIdentity = async (
	entry: ArchiveEntry,
	slug: { owner: string; repository: string },
	resolveRepository: RepositoryResolver
): Promise<CheckoutReport | ResolvedRepository> => {
	try {
		const repository = await resolveRepository(slug.owner, slug.repository);
		return isValidRepository(repository)
			? repository
			: failedCheckout(
					entry,
					'invalid-repository-identity',
					'Repository identity response contains invalid or inconsistent fields.'
				);
	} catch (err) {
		return failedCheckout(
			entry,
			'identity-resolution-failed',
			`Cannot resolve repository identity: ${sanitizeMessage(err instanceof Error ? err.message : String(err))}`
		);
	}
};

/**
 * Reports the local state that would make a folder rename unsafe.
 *
 * A path this platform cannot represent in a working tree is reported by Git
 * as a deletion that can never be resolved, so it is not local work and does
 * not block a rename. Migration only inspects; the exclusion that clears the
 * report is applied by the refresh that owns the checkout.
 */
const inspectBlockedReason = (entry: ArchiveEntry): null | string => {
	try {
		const paths = parsePorcelainStatusPaths(
			readMigrationGitRaw(entry.path, ['status', '--porcelain', '-z'])
		);
		return paths.length > 0 && !areAllPathsUnrepresentable(paths)
			? 'Local changes prevent a safe folder rename.'
			: null;
	} catch (err) {
		return `Local state cannot be verified: ${sanitizeMessage(err instanceof Error ? err.message : String(err))}`;
	}
};

export const resolveMigrationEntry = async (
	entry: ArchiveEntry,
	resolveRepository: RepositoryResolver
): Promise<CheckoutReport | ResolvedEntry> => {
	const slug = parseResolvableOrigin(entry);
	if ('outcome' in slug) return slug;
	const repository = await resolveRepositoryIdentity(entry, slug, resolveRepository);
	if ('outcome' in repository) return repository;
	return {
		blockedReason: inspectBlockedReason(entry),
		entry,
		preview: {
			classification: 'safely-migratable',
			proposedName: `${repository.name}--${repository.owner}`,
			repositoryId: repository.id,
			repositorySlug: repository.slug,
		},
	};
};

export const createGitHubRepositoryResolver = (token: string): RepositoryResolver => {
	const octokit = new Octokit({ auth: token });
	return async (owner, repository) => {
		const response = await withApiRetry(
			() => octokit.rest.repos.get({ owner, repo: repository }),
			{ maxRetries: 2 }
		);
		return {
			id: response.data.id,
			name: response.data.name,
			owner: response.data.owner.login,
			slug: response.data.full_name,
		};
	};
};
