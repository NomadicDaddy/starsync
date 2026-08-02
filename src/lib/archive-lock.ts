import fs from 'node:fs';
import path from 'node:path';

import type { ArchiveLockMetadata, ArchiveLockRuntime } from './archive-lock-metadata.ts';
import type { Subcommand } from './cli-utils.ts';

import {
	createArchiveLockRuntime,
	describeArchiveLock,
	parseArchiveLockMetadata,
} from './archive-lock-metadata.ts';

export const ARCHIVE_LOCK_FILENAME = 'operation-lock.json';

export interface ArchiveLockSnapshot {
	metadata: ArchiveLockMetadata | null;
	raw: string;
}

export interface HeldArchiveLock {
	allowsInitialization: boolean;
	cleanupMetadataDirectory: boolean;
	lockPath: string;
	metadata: ArchiveLockMetadata;
	raw: string;
}

export type ArchiveLockAcquisition =
	| {
			code: string;
			message: string;
			ok: false;
	  }
	| {
			held: HeldArchiveLock;
			ok: true;
			reclaimed: ArchiveLockMetadata | null;
	  };

export type ArchiveLockRemoval =
	{ code: string; message: string; ok: false } | { ok: true; removed: boolean };

const getErrorCode = (err: unknown): null | string => {
	if (typeof err !== 'object' || err === null || !('code' in err)) return null;
	return typeof err.code === 'string' ? err.code : null;
};

const getErrorMessage = (err: unknown): string =>
	err instanceof Error ? err.message : String(err);

const getArchiveLockPath = (targetPath: string): string =>
	path.join(path.resolve(targetPath), '.starsync', ARCHIVE_LOCK_FILENAME);

export const readArchiveLock = (targetPath: string): ArchiveLockSnapshot | null => {
	try {
		const lockPath = getArchiveLockPath(targetPath);
		const stats = fs.lstatSync(lockPath);
		const raw = fs.readFileSync(lockPath, 'utf8');
		return {
			metadata:
				stats.isFile() && !stats.isSymbolicLink() ? parseArchiveLockMetadata(raw) : null,
			raw,
		};
	} catch (err) {
		if (getErrorCode(err) === 'ENOENT') return null;
		throw err;
	}
};

const isSameHost = (left: string, right: string): boolean =>
	left.trim().toLowerCase() === right.trim().toLowerCase();

const isSoleArchiveLock = (targetPath: string): boolean => {
	try {
		const targetEntries = fs.readdirSync(targetPath);
		const metadataEntries = fs.readdirSync(path.join(targetPath, '.starsync'));
		return (
			targetEntries.length === 1 &&
			targetEntries[0] === '.starsync' &&
			metadataEntries.length === 1 &&
			metadataEntries[0] === ARCHIVE_LOCK_FILENAME
		);
	} catch {
		return false;
	}
};

const createLockFile = (
	lockPath: string,
	command: Subcommand,
	runtime: ArchiveLockRuntime
): { metadata: ArchiveLockMetadata; raw: string } => {
	const metadata: ArchiveLockMetadata = {
		command,
		hostname: runtime.hostname,
		lockId: runtime.createLockId(),
		pid: runtime.pid,
		startedAt: runtime.now().toISOString(),
	};
	const raw = `${JSON.stringify(metadata, null, '\t')}\n`;
	const descriptor = fs.openSync(lockPath, 'wx', 0o600);
	try {
		fs.writeFileSync(descriptor, raw, 'utf8');
		fs.fsyncSync(descriptor);
	} catch (err) {
		try {
			fs.unlinkSync(lockPath);
		} catch {
			// The original write error is the actionable failure.
		}
		throw err;
	} finally {
		fs.closeSync(descriptor);
	}
	return { metadata, raw };
};

export const removeArchiveLock = (
	targetPath: string,
	expectedRaw: string,
	cleanupMetadataDirectory: boolean
): ArchiveLockRemoval => {
	const lockPath = getArchiveLockPath(targetPath);
	let currentRaw: string;
	try {
		currentRaw = fs.readFileSync(lockPath, 'utf8');
	} catch (err) {
		if (getErrorCode(err) === 'ENOENT') return { ok: true, removed: false };
		return {
			code: 'archive-lock-read-failed',
			message: `Cannot re-read archive lock: ${getErrorMessage(err)}`,
			ok: false,
		};
	}
	if (currentRaw !== expectedRaw) {
		return {
			code: 'archive-lock-changed',
			message:
				'Archive lock ownership changed while it was being inspected; nothing was removed.',
			ok: false,
		};
	}
	try {
		fs.unlinkSync(lockPath);
		if (cleanupMetadataDirectory) {
			const metadataDirectory = path.dirname(lockPath);
			if (fs.readdirSync(metadataDirectory).length === 0) fs.rmdirSync(metadataDirectory);
		}
		return { ok: true, removed: true };
	} catch (err) {
		return {
			code: 'archive-lock-remove-failed',
			message: `Cannot remove archive lock: ${getErrorMessage(err)}`,
			ok: false,
		};
	}
};

export const acquireArchiveLock = (
	targetPath: string,
	command: Subcommand,
	runtime: ArchiveLockRuntime = createArchiveLockRuntime()
): ArchiveLockAcquisition => {
	const resolvedTarget = path.resolve(targetPath);
	const metadataDirectory = path.join(resolvedTarget, '.starsync');
	const lockPath = getArchiveLockPath(resolvedTarget);
	let metadataDirectoryCreated = false;
	try {
		fs.mkdirSync(metadataDirectory);
		metadataDirectoryCreated = true;
	} catch (err) {
		if (getErrorCode(err) !== 'EEXIST') {
			return {
				code: 'archive-lock-create-failed',
				message: `Cannot create archive lock directory: ${getErrorMessage(err)}`,
				ok: false,
			};
		}
		try {
			const stats = fs.lstatSync(metadataDirectory);
			if (!stats.isDirectory() || stats.isSymbolicLink()) {
				return {
					code: 'archive-lock-create-failed',
					message: 'Archive metadata path must be a real directory, not a file or link.',
					ok: false,
				};
			}
		} catch (err) {
			return {
				code: 'archive-lock-create-failed',
				message: `Cannot inspect archive lock directory: ${getErrorMessage(err)}`,
				ok: false,
			};
		}
	}

	let cleanupMetadataDirectory = metadataDirectoryCreated;
	let reclaimed: ArchiveLockMetadata | null = null;
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			const created = createLockFile(lockPath, command, runtime);
			return {
				held: {
					allowsInitialization: cleanupMetadataDirectory,
					cleanupMetadataDirectory,
					lockPath,
					...created,
				},
				ok: true,
				reclaimed,
			};
		} catch (err) {
			if (getErrorCode(err) !== 'EEXIST') {
				return {
					code: 'archive-lock-create-failed',
					message: `Cannot create archive lock: ${getErrorMessage(err)}`,
					ok: false,
				};
			}
		}

		let snapshot: ArchiveLockSnapshot | null;
		try {
			snapshot = readArchiveLock(resolvedTarget);
		} catch (err) {
			return {
				code: 'archive-lock-read-failed',
				message: `Cannot inspect the existing archive lock: ${getErrorMessage(err)}`,
				ok: false,
			};
		}
		if (snapshot === null) continue;
		if (snapshot.metadata === null) {
			return {
				code: 'archive-lock-force-required',
				message:
					'Archive lock metadata is invalid or incomplete; use unlock --force after assessing the risk.',
				ok: false,
			};
		}
		const owner = snapshot.metadata;
		if (!isSameHost(owner.hostname, runtime.hostname)) {
			return {
				code: 'archive-lock-force-required',
				message: `Archive is locked by ${describeArchiveLock(owner)}. Remote ownership cannot be confirmed; use unlock --force only after assessing the risk.`,
				ok: false,
			};
		}
		const processState = runtime.getProcessState(owner.pid);
		if (processState === 'alive') {
			return {
				code: 'archive-lock-active',
				message: `Archive is locked by live operation ${describeArchiveLock(owner)}.`,
				ok: false,
			};
		}
		if (processState === 'unknown') {
			return {
				code: 'archive-lock-force-required',
				message: `Archive is locked by ${describeArchiveLock(owner)}, but process liveness is uncertain; use unlock --force only after assessing the risk.`,
				ok: false,
			};
		}

		const lockWasSoleEntry = isSoleArchiveLock(resolvedTarget);
		const removal = removeArchiveLock(resolvedTarget, snapshot.raw, false);
		if (!removal.ok) {
			if (removal.code === 'archive-lock-changed') continue;
			return removal;
		}
		reclaimed = owner;
		cleanupMetadataDirectory ||= lockWasSoleEntry;
	}
	return {
		code: 'archive-lock-contention',
		message: 'Archive lock changed repeatedly during acquisition; nothing was changed.',
		ok: false,
	};
};

export const releaseArchiveLock = (held: HeldArchiveLock): ArchiveLockRemoval =>
	removeArchiveLock(
		path.dirname(path.dirname(held.lockPath)),
		held.raw,
		held.cleanupMetadataDirectory
	);

export { createArchiveLockRuntime, describeArchiveLock } from './archive-lock-metadata.ts';
export type { ArchiveLockMetadata, ArchiveLockRuntime } from './archive-lock-metadata.ts';
