import type { RefreshResult, RepoRecord, SyncPoolOptions, SyncPoolResult } from './refresh.ts';

type ProcessRepository = (
	repo: RepoRecord,
	isInterruptionRequested: () => boolean,
) => Promise<RefreshResult>;

interface PoolState {
	active: Map<number, { name: string; startedAt: number }>;
	completed: number;
	nextIndex: number;
	results: RefreshResult[];
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

const formatElapsed = (startedAt: number): string => {
	const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
	return `${elapsedSeconds}s`;
};

const reportHeartbeat = (
	state: PoolState,
	options: SyncPoolOptions,
	onProgress: (message: string) => void,
): void => {
	if (state.active.size === 0) return;
	const active = [...state.active.values()]
		.map(({ name, startedAt }) => `${name} (${formatElapsed(startedAt)})`)
		.join(', ');
	onProgress(
		`Still working — ${state.completed}/${options.totalCount} complete; active: ${active}`,
	);
};

const runWorker = async (
	repos: RepoRecord[],
	processRepository: ProcessRepository,
	options: SyncPoolOptions,
	state: PoolState,
): Promise<void> => {
	const onProgress = options.onProgress ?? ((message: string) => console.log(message));
	const interrupted = (): boolean => options.signal?.aborted ?? false;
	while (!interrupted()) {
		const index = state.nextIndex++;
		if (index >= repos.length) return;
		const repo = repos[index]!;
		const name = repo.folderName ?? repo.name;
		state.active.set(index, { name, startedAt: Date.now() });
		onProgress(`Syncing ${index + 1}/${options.totalCount} — ${name}`);
		if (interrupted()) {
			state.active.delete(index);
			return;
		}
		try {
			const result = await processRepository(repo, interrupted);
			state.results[index] = result;
			state.completed++;
			onProgress(
				`Completed ${state.completed}/${options.totalCount} — ${result.name}: ${result.outcome}`,
			);
		} finally {
			state.active.delete(index);
		}
	}
};

/** Runs repository work with bounded concurrency and graceful first interruption. */
export const runSyncPool = async (
	repos: RepoRecord[],
	processRepository: ProcessRepository,
	options: SyncPoolOptions,
): Promise<SyncPoolResult> => {
	const state: PoolState = {
		active: new Map(),
		completed: 0,
		nextIndex: 0,
		results: new Array<RefreshResult>(repos.length),
	};
	const workerCount = Math.min(options.concurrency, repos.length);
	const onProgress = options.onProgress ?? ((message: string) => console.log(message));
	const heartbeat = setInterval(
		() => reportHeartbeat(state, options, onProgress),
		options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
	);
	try {
		await Promise.all(
			Array.from({ length: workerCount }, () =>
				runWorker(repos, processRepository, options, state),
			),
		);
	} finally {
		clearInterval(heartbeat);
	}
	return {
		interrupted: options.signal?.aborted ?? false,
		results: state.results.filter((result) => result !== undefined),
	};
};
