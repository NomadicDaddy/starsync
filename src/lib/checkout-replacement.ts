import fs from 'node:fs';
import path from 'node:path';

import { removeReplacementRecord, writeReplacementRecord } from './checkout-replacement-record.ts';
import { sanitizeMessage } from './secret-safety.ts';

/** The two filesystem steps a replacement takes, injectable so tests can fail either one. */
export interface ReplacementFilesystem {
	remove: (target: string) => void;
	rename: (from: string, to: string) => void;
}

export const nodeReplacementFilesystem: ReplacementFilesystem = {
	remove: (target) => fs.rmSync(target, { force: true, recursive: true }),
	rename: (from, to) => fs.renameSync(from, to),
};

export interface ReplacementPublication {
	assertDestinationAvailable: () => void;
	backupPath: string;
	destinationPath: string;
	sourcePath: string;
	stagingPath: string;
	targetBase: string;
}

export interface ReplacedCheckout {
	cleanupWarning: null | string;
}

const errorMessage = (err: unknown): string =>
	sanitizeMessage(err instanceof Error ? err.message : String(err));

const tryRemoveRecord = (targetBase: string, backup: string): void => {
	try {
		removeReplacementRecord(targetBase, backup);
	} catch {
		// A stale record whose backup is gone is removed by the next cleanup pass.
	}
};

// Moves the original back after a failed publication. If that fails, the original stays at its
// backup name under a `pending` record, and the error says where.
const restoreOriginal = (
	io: ReplacementFilesystem,
	publication: ReplacementPublication,
	publicationError: unknown,
): void => {
	try {
		io.rename(publication.backupPath, publication.sourcePath);
	} catch (err) {
		throw new Error(
			`${errorMessage(publicationError)} The original checkout could not be moved back and is kept at ${path.basename(publication.backupPath)}: ${errorMessage(err)}`,
			{ cause: err },
		);
	}
};

/**
 * Moves the original checkout to its backup name, publishes the staged checkout in its place, and
 * deletes the original only after the replacement record says publication committed. If
 * publication fails the original is moved back. If that fails too, the original stays under its
 * backup name with a `pending` record, and cleanup keeps it, because it may be the only copy.
 * Throws when publication fails; the caller still owns the staging directory then.
 */
export const publishReplacement = (
	publication: ReplacementPublication,
	io: ReplacementFilesystem = nodeReplacementFilesystem,
): ReplacedCheckout => {
	const { backupPath, destinationPath, sourcePath, stagingPath, targetBase } = publication;
	const backup = path.basename(backupPath);
	const record = {
		backup,
		destination: path.basename(destinationPath),
		original: path.basename(sourcePath),
	};
	writeReplacementRecord(targetBase, { ...record, state: 'pending' });
	io.rename(sourcePath, backupPath);
	try {
		publication.assertDestinationAvailable();
		io.rename(stagingPath, destinationPath);
	} catch (err) {
		restoreOriginal(io, publication, err);
		tryRemoveRecord(targetBase, backup);
		throw err;
	}

	try {
		writeReplacementRecord(targetBase, { ...record, state: 'published' });
	} catch (err) {
		return {
			cleanupWarning: `Fresh checkout was published, but StarSync could not record that, so the replaced directory is kept at ${backup}: ${errorMessage(err)}`,
		};
	}
	try {
		io.remove(backupPath);
	} catch (err) {
		return {
			cleanupWarning: `Fresh checkout was published, but the replaced directory remains at ${backup}: ${errorMessage(err)}`,
		};
	}
	tryRemoveRecord(targetBase, backup);
	return { cleanupWarning: null };
};
