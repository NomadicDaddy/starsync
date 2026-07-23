import type { RefreshResult, RepoRecord, SyncPoolOptions, SyncPoolResult } from './refresh.ts';

type ProcessRepository = (
	repo: RepoRecord,
	isInterruptionRequested: () => boolean
) => Promise<RefreshResult>;

interface PoolState {
	nextIndex: number;
	results: RefreshResult[];
}

const runWorker = async (
	repos: RepoRecord[],
	processRepository: ProcessRepository,
	options: SyncPoolOptions,
	state: PoolState
): Promise<void> => {
	const onProgress = options.onProgress ?? ((message: string) => console.log(message));
	const interrupted = (): boolean => options.signal?.aborted ?? false;
	while (!interrupted()) {
		const index = state.nextIndex++;
		if (index >= repos.length) return;
		const repo = repos[index]!;
		onProgress(`Syncing ${index + 1}/${options.totalCount} — ${repo.folderName ?? repo.name}`);
		if (interrupted()) return;
		state.results[index] = await processRepository(repo, interrupted);
	}
};

/** Runs repository work with bounded concurrency and graceful first interruption. */
export const runSyncPool = async (
	repos: RepoRecord[],
	processRepository: ProcessRepository,
	options: SyncPoolOptions
): Promise<SyncPoolResult> => {
	const state: PoolState = {
		nextIndex: 0,
		results: new Array<RefreshResult>(repos.length),
	};
	const workerCount = Math.min(options.concurrency, repos.length);
	await Promise.all(
		Array.from({ length: workerCount }, () =>
			runWorker(repos, processRepository, options, state)
		)
	);
	return {
		interrupted: options.signal?.aborted ?? false,
		results: state.results.filter((result) => result !== undefined),
	};
};
