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

export interface SyncPoolOptions {
	concurrency: number;
	heartbeatIntervalMs?: number;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
	totalCount: number;
}

export interface SyncPoolResult {
	interrupted: boolean;
	results: RefreshResult[];
}

export { processRepository } from './refresh-existing.ts';
export { runSyncPool } from './refresh-pool.ts';
