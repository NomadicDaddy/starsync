export const DEFAULT_ARCHIVE_CONCURRENCY = 4;

export type ArchiveProgressCallback = (message: string) => void;

export interface ArchiveOperationOptions {
	onProgress?: ArchiveProgressCallback;
	signal?: AbortSignal;
	targetPath: string;
}

export interface NormalizeArchiveDatesOptions extends ArchiveOperationOptions {
	dryRun?: boolean;
}

export interface RenameArchiveOptions extends ArchiveOperationOptions {
	apply?: boolean;
	token: string;
}

export interface SyncArchiveOptions extends ArchiveOperationOptions {
	concurrency?: number;
	dryRun?: boolean;
	/** Bytes that must stay free at the target; zero disables the check. */
	minFreeSpace?: number;
	token: string;
}

export interface SyncContext {
	concurrency: number;
	dryRun: boolean;
	minFreeSpace: number;
	targetPath: string;
}

export interface VerifyArchiveOptions extends ArchiveOperationOptions {
	force?: boolean;
	/**
	 * Bytes that must stay free at the target before forced repair re-clones; zero
	 * disables the check. Read-only verification writes nothing and never measures.
	 */
	minFreeSpace?: number;
	token?: string;
}
