import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ARCHIVE_CONFIG_DIRECTORY } from './archive-config.ts';

/**
 * The durable record of one forced checkout replacement, kept in the archive's own metadata
 * directory. It is written as `pending` before the original checkout is moved to its backup name,
 * and rewritten as `published` only after the fresh checkout has reached its destination. Cleanup
 * deletes a replaced checkout's backup only when its record says `published`: an interruption, a
 * failed publication or a failed rollback leaves `pending` (or no record), and that backup may be
 * the only copy of the checkout.
 */
export interface CheckoutReplacementRecord {
	backup: string;
	destination: string;
	original: string;
	state: 'pending' | 'published';
}

export const REPLACEMENT_RECORD_DIRECTORY = 'replacements';

const RECORD_SUFFIX = '.json';

const recordDirectory = (targetBase: string): string =>
	path.join(targetBase, ARCHIVE_CONFIG_DIRECTORY, REPLACEMENT_RECORD_DIRECTORY);

const recordPath = (targetBase: string, backup: string): string =>
	path.join(recordDirectory(targetBase), `${backup}${RECORD_SUFFIX}`);

const isPlainName = (value: unknown): value is string =>
	typeof value === 'string' && value.length > 0 && path.basename(value) === value;

const isRealDirectory = (entryPath: string): boolean => {
	try {
		const stats = fs.lstatSync(entryPath, { throwIfNoEntry: false });
		return stats !== undefined && stats.isDirectory() && !stats.isSymbolicLink();
	} catch {
		return false;
	}
};

// Records are trusted, listed or removed only where both the archive's metadata directory and the
// records directory are real directories. A link at either place could otherwise supply
// publication evidence from somewhere else, or point a removal outside the archive.
const recordDirectoryIsReal = (targetBase: string): boolean =>
	isRealDirectory(path.join(targetBase, ARCHIVE_CONFIG_DIRECTORY)) &&
	isRealDirectory(recordDirectory(targetBase));

const ensureRecordDirectory = (targetBase: string): string => {
	const directory = recordDirectory(targetBase);
	if (!isRealDirectory(path.dirname(directory))) {
		throw new Error('Archive metadata path must be a real directory, not a file or link.');
	}
	// Callers hold the archive operation lock, so nothing else creates this between the two calls.
	if (fs.lstatSync(directory, { throwIfNoEntry: false }) === undefined) fs.mkdirSync(directory);
	if (!isRealDirectory(directory)) {
		throw new Error(
			'Checkout replacement records must be in a real directory, not a file or link.',
		);
	}
	return directory;
};

/** Writes the record through a new file and a rename, so a reader sees the old or the new record whole. */
export const writeReplacementRecord = (
	targetBase: string,
	record: CheckoutReplacementRecord,
): void => {
	if (![record.backup, record.destination, record.original].every(isPlainName)) {
		throw new Error('A checkout replacement record names a folder outside the archive.');
	}
	const directory = ensureRecordDirectory(targetBase);
	const temporary = path.join(directory, `.${randomUUID()}.tmp`);
	const descriptor = fs.openSync(temporary, 'wx', 0o600);
	try {
		try {
			fs.writeFileSync(descriptor, `${JSON.stringify(record, null, '\t')}\n`, 'utf-8');
			fs.fsyncSync(descriptor);
		} finally {
			fs.closeSync(descriptor);
		}
		fs.renameSync(temporary, recordPath(targetBase, record.backup));
	} catch (err) {
		fs.rmSync(temporary, { force: true });
		throw err;
	}
};

// The parsed record when every field is well formed and it names this backup, otherwise null.
const validRecord = (
	value: Partial<CheckoutReplacementRecord>,
	backup: string,
): CheckoutReplacementRecord | null => {
	const { destination, original, state } = value;
	if (value.backup !== backup || !isPlainName(original) || !isPlainName(destination)) return null;
	if (state !== 'pending' && state !== 'published') return null;
	return { backup, destination, original, state };
};

/**
 * The record for a backup, or null when there is none or it can't be trusted: missing, a link,
 * in a linked records directory, unreadable, malformed, or naming a different backup. Null never
 * permits deletion.
 */
export const readReplacementRecord = (
	targetBase: string,
	backup: string,
): CheckoutReplacementRecord | null => {
	const file = recordPath(targetBase, backup);
	try {
		if (!recordDirectoryIsReal(targetBase)) return null;
		const stats = fs.lstatSync(file, { throwIfNoEntry: false });
		if (stats === undefined || !stats.isFile() || stats.isSymbolicLink()) return null;
		return validRecord(
			JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<CheckoutReplacementRecord>,
			backup,
		);
	} catch {
		return null;
	}
};

export const removeReplacementRecord = (targetBase: string, backup: string): void => {
	if (!recordDirectoryIsReal(targetBase)) {
		throw new Error(
			'Refusing to remove a checkout replacement record outside a real directory.',
		);
	}
	fs.rmSync(recordPath(targetBase, backup), { force: true });
};

/**
 * The backup names that have a record file, whatever its content. Temporary files end `.tmp`.
 * Throws when the records directory can't be read; the caller reports that and moves on.
 */
export const listReplacementRecordBackups = (targetBase: string): string[] => {
	const directory = recordDirectory(targetBase);
	if (!recordDirectoryIsReal(targetBase)) return [];
	return fs
		.readdirSync(directory)
		.filter((name) => name.endsWith(RECORD_SUFFIX))
		.map((name) => name.slice(0, -RECORD_SUFFIX.length));
};

const TEMPORARY_RECORD_PATTERN =
	/^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

/**
 * Removes temporary record files a stopped write left behind. Only names writeReplacementRecord
 * makes (`.<uuid>.tmp`), only regular files, and only in a real records directory. Under the
 * archive lock no write is in progress, so any such file is abandoned. Throws when the directory
 * can't be read, like listReplacementRecordBackups.
 */
export const removeTemporaryRecordFiles = (targetBase: string): void => {
	const directory = recordDirectory(targetBase);
	if (!recordDirectoryIsReal(targetBase)) return;
	for (const name of fs.readdirSync(directory)) {
		if (!TEMPORARY_RECORD_PATTERN.test(name)) continue;
		const file = path.join(directory, name);
		const stats = fs.lstatSync(file, { throwIfNoEntry: false });
		if (stats?.isFile() === true && !stats.isSymbolicLink()) fs.rmSync(file, { force: true });
	}
};
