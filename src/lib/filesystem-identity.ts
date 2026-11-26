import fs from 'node:fs';

const identityOf = (target: string): fs.BigIntStats | undefined => {
	try {
		return fs.statSync(target, { bigint: true, throwIfNoEntry: false });
	} catch {
		return undefined;
	}
};

const canonicalOf = (target: string): null | string => {
	try {
		return fs.realpathSync.native(target);
	} catch {
		return null;
	}
};

/**
 * Whether two paths name the same existing file or directory. Both tests must hold:
 * - the volume and file index the operating system reports are equal and nonzero, and
 * - the native canonical forms are identical, compared exactly. The native call expands a Windows
 *   8.3 short name and gives each name in its on-disk letter case.
 *
 * Aliases of one directory, such as a short path or another spelling of a case-insensitive name,
 * pass both. Two distinct directories fail, including names that differ only in letter case where
 * Windows per-directory case sensitivity is on. The canonical check also covers file systems whose
 * 64-bit index isn't guaranteed unique, such as ReFS. A missing or unreadable path, or one reported
 * with no file index, can't be identified, so the answer is false.
 */
export const sameFilesystemEntry = (left: string, right: string): boolean => {
	const leftIdentity = identityOf(left);
	const rightIdentity = identityOf(right);
	if (leftIdentity === undefined || rightIdentity === undefined) return false;
	if (leftIdentity.ino === 0n || rightIdentity.ino === 0n) return false;
	if (leftIdentity.dev !== rightIdentity.dev || leftIdentity.ino !== rightIdentity.ino)
		return false;
	const leftCanonical = canonicalOf(left);
	return leftCanonical !== null && leftCanonical === canonicalOf(right);
};
