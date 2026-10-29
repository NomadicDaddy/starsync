import { posix } from 'node:path';

import type { SharedCoreFile } from './manifest.ts';

function fail(message: string): never {
	throw new Error(`shared-core-manifest.json: ${message}`);
}

/**
 * Refuses a path a lock could not hold. Every manifest path ends up in a lock key, and the lock
 * reader rejects a key with a backslash, so a path accepted here would produce a lock its own
 * reader calls corrupt. Absolute and `..` paths would reach outside the repository, and an
 * unnormalized one would key the same file twice. A root may be `.`.
 */
export function assertLockablePath(value: string, where: string): void {
	const reason = unlockableReason(value);
	if (reason !== null) fail(`${where} path '${value}' ${reason}; use a relative path with /.`);
}

function unlockableReason(value: string): null | string {
	if (value.includes('\\')) return 'contains a backslash';
	if (posix.isAbsolute(value) || /^[A-Za-z]:/u.test(value)) return 'is absolute';
	if (value.split('/').includes('..')) return 'leaves the repository with ..';
	if (posix.normalize(value) !== value || value.endsWith('/')) {
		return `is not in normal form (${posix.normalize(value)})`;
	}
	return null;
}

/** Reads one file entry of a group from the manifest's raw JSON. Throws on anything unverifiable. */
export function asFile(raw: unknown, where: string): SharedCoreFile {
	if (raw === null || typeof raw !== 'object') fail(`${where} must be an object.`);
	const file = raw as Record<string, unknown>;
	const source = file['source'];
	if (typeof source !== 'string' || source.length === 0) {
		fail(`${where} needs a non-empty source.`);
	}
	const disposition = file['disposition'];
	if (disposition !== 'seeded' && disposition !== 'synced') {
		fail(`${where} disposition must be 'seeded' or 'synced'.`);
	}

	// Both halves or neither. A fallbackSource with no predicate can never be selected, and a
	// predicate with no fallback turns an unmet contract into a silent skip rather than a lesser
	// install — which is how a repository ends up with a hook calling a script it does not define,
	// failing every commit instead of guarding it.
	const requiresScripts = file['requiresScripts'];
	const fallbackSource = file['fallbackSource'];
	if ((requiresScripts === undefined) !== (fallbackSource === undefined)) {
		fail(`${where} must declare requiresScripts and fallbackSource together, or neither.`);
	}
	if (requiresScripts !== undefined) {
		if (
			!Array.isArray(requiresScripts) ||
			requiresScripts.length === 0 ||
			requiresScripts.some((s) => typeof s !== 'string')
		) {
			fail(`${where} requiresScripts must be a non-empty array of script names.`);
		}
		if (typeof fallbackSource !== 'string' || fallbackSource.length === 0) {
			fail(`${where} fallbackSource must be a non-empty string.`);
		}
	}

	const target = file['target'];
	if (target !== undefined && (typeof target !== 'string' || target.length === 0)) {
		fail(`${where} target must be a non-empty string when present.`);
	}
	assertLockablePath(source, `${where} source`);
	if (typeof target === 'string') assertLockablePath(target, `${where} target`);
	if (typeof fallbackSource === 'string') {
		assertLockablePath(fallbackSource, `${where} fallbackSource`);
	}

	return {
		disposition,
		source,
		...(typeof target === 'string' ? { target } : {}),
		...(requiresScripts === undefined
			? {}
			: {
					fallbackSource: fallbackSource as string,
					requiresScripts: requiresScripts as string[],
				}),
	};
}
