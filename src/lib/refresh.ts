import fs from 'node:fs';
import path from 'node:path';

import { isTransientGitError, runGit } from './git-exec.ts';
import { isGitAuthError, sanitizeMessage, CREDENTIAL_GUIDANCE } from './secret-safety.ts';

// ── Types ───────────────────────────────────────────────────────────────────

/** The sync outcome for a single checkout attempt. */
export type SyncOutcome =
	'added' | 'blocked' | 'current' | 'failed' | 'retained' | 'skipped' | 'updated';

/** A starred repository from the GitHub API. */
export interface RepoRecord {
	clone_url: string;
	name: string;
}

/** Result of refreshing or cloning a single repository. */
export interface RefreshResult {
	message?: string;
	name: string;
	outcome: SyncOutcome;
}

// ── Deterministic delay ─────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

// ── Clone (new repository) ──────────────────────────────────────────────────

/**
 * Clones a new repository. Retries transient transport failures once.
 */
const cloneRepository = async (repo: RepoRecord, targetBase: string): Promise<RefreshResult> => {
	const attempt = async (): Promise<void> => {
		await runGit(['clone', repo.clone_url, repo.name], { cwd: targetBase });
	};

	try {
		await attempt();
		return { name: repo.name, outcome: 'added' };
	} catch (err) {
		const message = (err as Error).message;
		if (isTransientGitError(sanitizeMessage(message))) {
			// Single retry for transient transport failure
			await sleep(1000);
			try {
				await attempt();
				return { name: repo.name, outcome: 'added' };
			} catch (err) {
				return buildFailure(repo.name, err);
			}
		}
		return buildFailure(repo.name, err);
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

// ── Refresh (existing checkout) ─────────────────────────────────────────────

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

/**
 * Refreshes an existing checkout safely.
 *
 * 1. Fetches all remote branches and tags without pruning.
 * 2. Checks whether the working tree is clean (no uncommitted changes).
 * 3. If clean and the local branch is behind the remote, fast-forwards.
 * 4. If dirty or divergent, the checkout is blocked (retained as-is).
 *
 * Retries transient transport failures once on the fetch step.
 */
const refreshCheckout = async (repoPath: string, name: string): Promise<RefreshResult> => {
	const doFetch = async (): Promise<void> => {
		// Fetch all branches and tags without pruning remote-tracking references
		await runGit(['fetch', '--tags', '--no-prune', 'origin'], {
			cwd: repoPath,
			env: GIT_ENV,
		});
	};

	// Fetch with transient retry
	try {
		await doFetch();
	} catch (err) {
		const message = sanitizeMessage((err as Error).message);
		if (isTransientGitError(message)) {
			await sleep(1000);
			try {
				await doFetch();
			} catch (err) {
				return buildFailure(name, err);
			}
		} else {
			return buildFailure(name, err);
		}
	}

	// Check if working tree is clean
	let statusOutput: string;
	try {
		statusOutput = await runGit(['status', '--porcelain'], { cwd: repoPath });
	} catch (err) {
		return buildFailure(name, err);
	}

	if (statusOutput.length > 0) {
		// Working tree is dirty — block the checkout
		return {
			message: 'Local changes detected — checkout blocked to preserve uncommitted work.',
			name,
			outcome: 'blocked',
		};
	}

	// Check if HEAD tracks a remote branch
	let upstreamRef: string;
	try {
		upstreamRef = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
			cwd: repoPath,
		});
	} catch {
		// No upstream tracking branch — cannot fast-forward; report as current
		return { name, outcome: 'current' };
	}

	// Compare local and remote HEADs
	let localHash: string;
	let remoteHash: string;
	try {
		localHash = await runGit(['rev-parse', 'HEAD'], { cwd: repoPath });
		remoteHash = await runGit(['rev-parse', upstreamRef], { cwd: repoPath });
	} catch (err) {
		return buildFailure(name, err);
	}

	if (localHash === remoteHash) {
		return { name, outcome: 'current' };
	}

	// Check if local is an ancestor of remote (fast-forwardable)
	let canFastForward: boolean;
	try {
		await runGit(['merge-base', '--is-ancestor', localHash, remoteHash], { cwd: repoPath });
		canFastForward = true;
	} catch {
		// merge-base --is-ancestor exits non-zero when NOT an ancestor (divergent)
		canFastForward = false;
	}

	if (!canFastForward) {
		return {
			message: 'Local and remote have diverged — checkout blocked to preserve local history.',
			name,
			outcome: 'blocked',
		};
	}

	// Fast-forward the checked-out branch
	try {
		await runGit(['merge', '--ff-only', upstreamRef], {
			cwd: repoPath,
			env: GIT_ENV,
		});
		return { name, outcome: 'updated' };
	} catch (err) {
		return buildFailure(name, err);
	}
};

// ── Single-repository processing ────────────────────────────────────────────

/**
 * Processes a single repository: clone if new, refresh if existing.
 * Validates that the origin is GitHub.com before any Git operation.
 */
export const processRepository = async (
	repo: RepoRecord,
	targetBase: string,
	isInterruptionRequested: () => boolean
): Promise<RefreshResult> => {
	const repoPath = path.join(targetBase, repo.name);
	const hasGitDir = fs.existsSync(repoPath) && fs.existsSync(path.join(repoPath, '.git'));

	if (!hasGitDir) {
		return cloneRepository(repo, targetBase);
	}

	if (isInterruptionRequested()) {
		// We've already started: let in-flight Git ops finish but don't start new fetches
		return {
			message: 'Interrupted before refresh could start.',
			name: repo.name,
			outcome: 'skipped',
		};
	}

	return refreshCheckout(repoPath, repo.name);
};

// ── Concurrency pool ────────────────────────────────────────────────────────

/**
 * Configuration for the sync pool.
 */
export interface SyncPoolOptions {
	concurrency: number;
	totalCount: number;
}

/**
 * Shared interruption state that allows the pool to signal workers
 * and individual repository processors that an interrupt was received.
 */
interface InterruptionState {
	level: number;
}

/**
 * A bound-concurrency pool that processes repositories concurrently.
 *
 * - Default concurrency is 4; can be set 1–8 via --concurrency.
 * - --concurrency 1 is fully deterministic (sequential).
 * - Prints "Syncing N/Total" progress for each repository.
 * - On first interruption: stops scheduling new work and lets in-flight
 *   operations finish. A second interruption terminates immediately.
 *
 * The processFn receives an `isInterruptionRequested` callback so it can
 * check whether a Ctrl+C was received before starting long operations.
 */
export const runSyncPool = async (
	repos: RepoRecord[],
	processFn: (repo: RepoRecord, isInterruptionRequested: () => boolean) => Promise<RefreshResult>,
	options: SyncPoolOptions
): Promise<RefreshResult[]> => {
	const results: RefreshResult[] = new Array(repos.length);
	let nextIndex = 0;
	const interruption: InterruptionState = { level: 0 };

	const isInterruptionRequested = (): boolean => interruption.level >= 1;

	const worker = async (): Promise<void> => {
		while (true) {
			// On first interruption, stop picking up new work
			if (interruption.level >= 1) return;

			const index = nextIndex++;
			if (index >= repos.length) return;

			const repo = repos[index]!;
			console.log(`\nSyncing ${index + 1}/${options.totalCount} — ${repo.name}`);

			const result = await processFn(repo, isInterruptionRequested);
			results[index] = result;
		}
	};

	// Set up signal handler for graceful interruption
	const sigintHandler = () => {
		interruption.level++;
		if (interruption.level === 1) {
			console.warn(
				'\nInterrupt received — finishing in-flight operations. Press Ctrl+C again to stop immediately.'
			);
		} else {
			console.warn('\nSecond interrupt — stopping immediately.');
			process.exit(130);
		}
	};

	const hadSigintHandler = process.listenerCount('SIGINT') > 0;
	process.on('SIGINT', sigintHandler);

	try {
		const workers: Promise<void>[] = [];
		const workerCount = Math.min(options.concurrency, repos.length);
		for (let i = 0; i < workerCount; i++) {
			workers.push(worker());
		}
		await Promise.all(workers);
	} finally {
		process.removeListener('SIGINT', sigintHandler);
		if (!hadSigintHandler && process.listenerCount('SIGINT') === 0) {
			// Ensure we don't leave a dangling handler reference
		}
	}

	return results.filter((r) => r !== undefined);
};
