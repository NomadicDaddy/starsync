import type { CommandReport } from './reporting.ts';

import { normalizeArchiveDatesUnlocked } from './archive-api-dates.ts';
import { migrateArchiveUnlocked } from './archive-api-migration.ts';
import { syncArchiveUnlocked } from './archive-api-sync.ts';
import { verifyArchiveUnlocked } from './archive-api-verification.ts';
import { initArchiveUnlocked, type InitArchiveOptions } from './archive-initialization.ts';
import { withArchiveOperationLock } from './archive-operation-lock.ts';
import { unlockArchive, type UnlockArchiveOptions } from './archive-unlock.ts';

export const DEFAULT_ARCHIVE_CONCURRENCY = 4;

export type ArchiveProgressCallback = (message: string) => void;

export interface ArchiveOperationOptions {
	onProgress?: ArchiveProgressCallback;
	signal?: AbortSignal;
	targetPath: string;
}

export interface MigrateArchiveOptions extends ArchiveOperationOptions {
	apply?: boolean;
	token: string;
}

export interface NormalizeArchiveDatesOptions extends ArchiveOperationOptions {
	dryRun?: boolean;
}

export interface SyncArchiveOptions extends ArchiveOperationOptions {
	concurrency?: number;
	dryRun?: boolean;
	token: string;
}

export interface VerifyArchiveOptions extends ArchiveOperationOptions {
	force?: boolean;
	token?: string;
}

export const initArchive = (options: InitArchiveOptions): Promise<CommandReport> =>
	withArchiveOperationLock('init', options, (held) => initArchiveUnlocked(options, held));

export const migrateArchive = (options: MigrateArchiveOptions): Promise<CommandReport> =>
	withArchiveOperationLock(
		'migrate',
		options,
		() => migrateArchiveUnlocked(options),
		!(options.apply ?? false)
	);

export const normalizeArchiveDates = (
	options: NormalizeArchiveDatesOptions
): Promise<CommandReport> =>
	withArchiveOperationLock(
		'dates',
		options,
		() => normalizeArchiveDatesUnlocked(options),
		options.dryRun ?? false
	);

export const syncArchive = (options: SyncArchiveOptions): Promise<CommandReport> =>
	withArchiveOperationLock(
		'sync',
		options,
		() => syncArchiveUnlocked(options),
		options.dryRun ?? false
	);

export const verifyArchive = (options: VerifyArchiveOptions): Promise<CommandReport> =>
	withArchiveOperationLock('verify', options, () => verifyArchiveUnlocked(options));

export { unlockArchive };
export type { InitArchiveOptions, UnlockArchiveOptions };
