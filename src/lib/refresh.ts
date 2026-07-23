import fs from 'node:fs';
import path from 'node:path';

import { finalizeCheckoutIdentity } from './checkout-identity.ts';
import { refreshCheckoutOnDefaultBranch } from './default-branch-refresh.ts';
import { isGitAuthError, sanitizeMessage, CREDENTIAL_GUIDANCE } from './secret-safety.ts';
import { createStagedCheckout } from './staged-checkout.ts';

/** The sync outcome for a single checkout attempt. */
export type SyncOutcome =
	'added' | 'blocked' | 'current' | 'failed' | 'retained' | 'skipped' | 'updated';

/** A starred repository from the GitHub API. */
export interface RepoRecord {
	clone_url: string;
	defaultBranch: string;
	folderName?: string;
	id?: number;
	name: string;
	pendingRename?: boolean;
	slug?: string;
}

/** Result of refreshing or cloning a single repository. */
export interface RefreshResult {
	message?: string;
	name: string;
	outcome: SyncOutcome;
	pendingRename?: boolean;
}

export interface ProcessRepositoryOptions {
	archiveOwnerId: number;
}

/** Clones, validates, and atomically publishes a new managed checkout. */
const cloneRepository = async (
	repo: RepoRecord,
	targetBase: string,
	options: ProcessRepositoryOptions
): Promise<RefreshResult> => {
	const folderName = repo.folderName ?? repo.name;
	try {
		if (repo.id === undefined || repo.slug === undefined) {
			throw new Error('New managed checkout is missing its stable repository identity.');
		}
		await createStagedCheckout(
			{
				cloneUrl: repo.clone_url,
				folderName,
				repositoryId: repo.id,
				repositorySlug: repo.slug,
			},
			targetBase,
			options
		);
		return { name: folderName, outcome: 'added' };
	} catch (err) {
		return buildFailure(folderName, err);
	}
};

/**
 * Builds a failure RefreshResult from an error, applying secret-safety
 * sanitization and credential guidance.
 */
const buildFailure = (name: string, err: unknown): RefreshResult => {
	const rawMessage = err instanceof Error ? err.message : String(err);
	let message = sanitizeMessage(rawMessage);
	if (isGitAuthError(rawMessage)) {
		message = `${message}\n${CREDENTIAL_GUIDANCE}`;
	}
	return { message, name, outcome: 'failed' };
};

/**
 * Processes a single repository: clone if new, refresh if existing.
 * Validates that the origin is GitHub.com before any Git operation.
 */
export const processRepository = async (
	repo: RepoRecord,
	targetBase: string,
	isInterruptionRequested: () => boolean,
	options: ProcessRepositoryOptions
): Promise<RefreshResult> => {
	const folderName = repo.folderName ?? repo.name;
	const repoPath = path.join(targetBase, folderName);
	const hasGitDir = fs.existsSync(repoPath) && fs.existsSync(path.join(repoPath, '.git'));

	let result: RefreshResult;
	if (isInterruptionRequested()) {
		// We've already started: let in-flight Git ops finish but don't start new fetches
		result = {
			message: 'Interrupted before Git work could start.',
			name: folderName,
			outcome: 'skipped',
		};
	} else if (!hasGitDir) {
		result = await cloneRepository(repo, targetBase, options);
	} else {
		result = await refreshCheckoutOnDefaultBranch(repoPath, folderName, repo.defaultBranch);
	}

	if (
		repo.id !== undefined &&
		repo.slug !== undefined &&
		result.outcome !== 'added' &&
		result.outcome !== 'failed' &&
		result.outcome !== 'skipped'
	) {
		const metadataError = await finalizeCheckoutIdentity(repoPath, {
			repositoryId: repo.id,
			repositorySlug: repo.slug,
		});
		if (metadataError !== null) return buildFailure(folderName, metadataError);
	}
	return { ...result, pendingRename: repo.pendingRename ?? false };
};

/**
 * Configuration for the sync pool.
 */
export interface SyncPoolOptions {
	concurrency: number;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
	totalCount: number;
}

export interface SyncPoolResult {
	interrupted: boolean;
	results: RefreshResult[];
}

/**
 * A bound-concurrency pool that processes repositories concurrently.
 *
 * - Default concurrency is 4; can be set 1–8 via --concurrency.
 * - --concurrency 1 is fully deterministic (sequential).
 * - Prints "Syncing N/Total" progress for each repository.
 * - An aborted signal stops scheduling new work and lets in-flight operations finish.
 *
 * The processFn receives an `isInterruptionRequested` callback so it can
 * check whether a Ctrl+C was received before starting long operations.
 */
export const runSyncPool = async (
	repos: RepoRecord[],
	processFn: (repo: RepoRecord, isInterruptionRequested: () => boolean) => Promise<RefreshResult>,
	options: SyncPoolOptions
): Promise<SyncPoolResult> => {
	const results: RefreshResult[] = new Array(repos.length);
	let nextIndex = 0;
	const onProgress = options.onProgress ?? ((message: string) => console.log(message));

	const isInterruptionRequested = (): boolean => options.signal?.aborted ?? false;

	const worker = async (): Promise<void> => {
		while (true) {
			// On first interruption, stop picking up new work
			if (isInterruptionRequested()) return;

			const index = nextIndex++;
			if (index >= repos.length) return;

			const repo = repos[index]!;
			onProgress(
				`Syncing ${index + 1}/${options.totalCount} — ${repo.folderName ?? repo.name}`
			);
			if (isInterruptionRequested()) return;

			const result = await processFn(repo, isInterruptionRequested);
			results[index] = result;
		}
	};

	const workers: Promise<void>[] = [];
	const workerCount = Math.min(options.concurrency, repos.length);
	for (let i = 0; i < workerCount; i++) {
		workers.push(worker());
	}
	await Promise.all(workers);

	return {
		interrupted: isInterruptionRequested(),
		results: results.filter((result) => result !== undefined),
	};
};
