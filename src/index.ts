import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	createGitHubRepositoryResolver as createGitHubRepositoryResolverImpl,
	inspectArchive as inspectArchiveImpl,
	parseGitHubRepositorySlug as parseGitHubRepositorySlugImpl,
	previewArchiveMigration as previewArchiveMigrationImpl,
} from './lib/archive-migration.ts';
import { verifyArchive as verifyArchiveContentsImpl } from './lib/archive-verification.ts';
import {
	resolveTargetPath as resolveTargetPathImpl,
	stripQuotes as stripQuotesImpl,
} from './lib/cli-utils.ts';
import {
	isGitAuthError,
	isGitHubDotComUrl,
	sanitizeMessage,
	sanitizeUrl,
	CREDENTIAL_GUIDANCE,
} from './lib/secret-safety.ts';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, '..');

export {
	DEFAULT_ARCHIVE_CONCURRENCY,
	initArchive,
	migrateArchive,
	normalizeArchiveDates,
	syncArchive,
	unlockArchive,
	verifyArchive,
	type ArchiveOperationOptions,
	type ArchiveProgressCallback,
	type InitArchiveOptions,
	type MigrateArchiveOptions,
	type NormalizeArchiveDatesOptions,
	type SyncArchiveOptions,
	type UnlockArchiveOptions,
	type VerifyArchiveOptions,
} from './lib/archive-api.ts';
export { REPOSITORY_ID_KEY, REPOSITORY_SLUG_KEY } from './lib/checkout-identity.ts';

/** @deprecated Explicit archive operation options do not require quote stripping. */
export const stripQuotes = stripQuotesImpl;

/** @deprecated Use migrateArchive, which returns a structured CommandReport. */
export const createGitHubRepositoryResolver = createGitHubRepositoryResolverImpl;

/** @deprecated Use verifyArchive or migrateArchive instead of inspecting archive internals. */
export const inspectArchive = inspectArchiveImpl;

/** @deprecated Repository slug parsing is internal to archive operations. */
export const parseGitHubRepositorySlug = parseGitHubRepositorySlugImpl;

/** @deprecated Use migrateArchive, which returns a structured CommandReport. */
export const previewArchiveMigration = previewArchiveMigrationImpl;

export { DEFAULT_CONCURRENCY, parseArgs, type ParsedArgs } from './lib/cli-utils.ts';
export { SYNC_HELP_TEXT as HELP_TEXT } from './lib/help-text.ts';

/** @deprecated Use verifyArchive, which returns a structured CommandReport. */
export const verifyArchiveContents = verifyArchiveContentsImpl;
export type {
	CheckoutLifecycle,
	CheckoutReport,
	CommandExitCode,
	CommandOutcome,
	CommandReport,
	Finding,
	FindingSeverity,
} from './lib/reporting.ts';

/** @deprecated Pass targetPath explicitly to an archive operation instead. */
export const resolveTargetPath = (
	positional: null | string,
	envTarget: string | undefined = process.env.TARGET_PATH,
	baseDir: string = repoDir
): string => resolveTargetPathImpl(positional, envTarget, baseDir);

/** @deprecated Archive discovery is internal to command-level archive operations. */
export const listFolders = (dirPath: string): Set<string> => {
	if (!fs.existsSync(dirPath)) return new Set();
	return new Set(
		fs
			.readdirSync(dirPath, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
	);
};

export interface Repository {
	clone_url: string;
	name: string;
}

export interface SyncFailure {
	message: string;
	name: string;
	verb: 'clone' | 'pull';
}

export type SyncResult = { failure: null; ok: true } | { failure: SyncFailure; ok: false };

/** @deprecated Repository URL normalization is internal to archive operations. */
export const normalizeRepoUrl = (url: string): string => {
	const normalized = url
		.trim()
		.normalize('NFC')
		.replace(/\/+$/, '')
		.replace(/\.git$/i, '');
	const scpStyleSsh = /^git@([^:]+):(.+)$/i.exec(normalized);
	if (scpStyleSsh !== null) {
		return `${scpStyleSsh[1]}/${scpStyleSsh[2]}`.toLowerCase();
	}
	try {
		const parsed = new URL(normalized);
		if (
			parsed.hostname.toLowerCase() === 'github.com' &&
			['http:', 'https:', 'ssh:'].includes(parsed.protocol)
		) {
			const pathname = decodeURI(parsed.pathname).normalize('NFC');
			return `${parsed.hostname}${pathname}`.replace(/^\/+|\/+$/g, '').toLowerCase();
		}
	} catch {
		// Preserve compatibility for non-URL values accepted by this deprecated helper.
	}
	return normalized.toLowerCase();
};

/** @deprecated Use syncArchive, which returns a structured CommandReport. */
export const cloneOrPull = (
	repo: Repository,
	targetBase: string,
	existing: Set<string>
): SyncResult => {
	console.log(`\n${repo.name}`);

	// Validate that the repository origin is GitHub.com (reject GHE and other hosts)
	if (!isGitHubDotComUrl(repo.clone_url)) {
		const sanitized = sanitizeUrl(repo.clone_url);
		const msg = `Repository origin is not GitHub.com: ${sanitized}`;
		console.warn(`Skipping ${repo.name}: ${msg}`);
		return {
			failure: {
				message: msg,
				name: repo.name,
				verb: 'clone',
			},
			ok: false,
		};
	}

	const repoPath = path.join(targetBase, repo.name);
	const isCloned =
		(existing.has(repo.name) || fs.existsSync(repoPath)) &&
		fs.existsSync(path.join(repoPath, '.git'));
	const verb = isCloned ? 'pull' : 'clone';
	try {
		if (isCloned) {
			const remoteUrl = execFileSync(
				'git',
				['-C', repoPath, 'config', '--get', 'remote.origin.url'],
				{
					encoding: 'utf-8',
				}
			).trim();
			if (normalizeRepoUrl(remoteUrl) !== normalizeRepoUrl(repo.clone_url)) {
				const expectedSanitized = sanitizeUrl(repo.clone_url);
				const foundSanitized = sanitizeUrl(remoteUrl);
				const msg = `Remote URL mismatch (expected ${expectedSanitized}, found ${foundSanitized})`;
				console.warn(`Skipping ${repo.name}: ${msg}`);
				return {
					failure: {
						message: msg,
						name: repo.name,
						verb: 'clone',
					},
					ok: false,
				};
			}
			console.log('Repository is already available -> pulling');
			execFileSync('git', ['-c', 'core.askPass=', 'pull'], {
				cwd: repoPath,
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
				stdio: 'inherit',
			});
		} else {
			console.log('Repository not available -> cloning');
			execFileSync('git', ['-c', 'core.askPass=', 'clone', repo.clone_url], {
				cwd: targetBase,
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
				stdio: 'inherit',
			});
		}
		return { failure: null, ok: true };
	} catch (err) {
		const rawMessage = (err as Error).message;
		let message = sanitizeMessage(rawMessage);
		if (isGitAuthError(rawMessage)) {
			message = `${message}\n${CREDENTIAL_GUIDANCE}`;
		}
		console.error(`Failed to ${verb} ${repo.name}: ${message}`);
		return { failure: { message, name: repo.name, verb }, ok: false };
	}
};

/**
 * @deprecated Use syncArchive with explicit options and consume its CommandReport.
 */
export const runStarsync = async (argv: string[] = process.argv.slice(2)): Promise<number> => {
	const { dispatchSync } = await import('./lib/subcommands.ts');
	return dispatchSync(argv);
};
