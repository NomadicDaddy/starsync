import fs from 'node:fs';

const identityOf = (target: string): fs.BigIntStats | undefined => {
	try {
		return fs.statSync(target, { bigint: true, throwIfNoEntry: false });
	} catch {
		return undefined;
	}
};

/**
 * Whether two paths name the same existing file or directory, judged by the volume and file index
 * the operating system reports rather than by spelling. Aliases of one directory, such as a Windows
 * 8.3 short path or another spelling of a case-insensitive name, match. Two distinct directories
 * never do, including directories whose names differ only in letter case, which Windows allows
 * where per-directory case sensitivity is on. A missing or unreadable path, or an entry the
 * filesystem reports no file index for, can't be identified, so the answer is false.
 */
export const sameFilesystemEntry = (left: string, right: string): boolean => {
	const leftIdentity = identityOf(left);
	const rightIdentity = identityOf(right);
	if (leftIdentity === undefined || rightIdentity === undefined) return false;
	if (leftIdentity.ino === 0n || rightIdentity.ino === 0n) return false;
	return leftIdentity.dev === rightIdentity.dev && leftIdentity.ino === rightIdentity.ino;
};
