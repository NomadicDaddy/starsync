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
	token: string;
}

export interface SyncContext {
	concurrency: number;
	dryRun: boolean;
	targetPath: string;
}

export interface VerifyArchiveOptions extends ArchiveOperationOptions {
	force?: boolean;
	token?: string;
}
