/**
 * `smokestack.lock`: what a repository takes from the owner, and what it last received.
 *
 * The file is tracked at the root of each repository that carries shared files. Its `groups` keys
 * are the groups that repository takes. A group whose value is `{}` is declared and not yet
 * delivered; a delivered group holds `files`, keyed by INSTALLED path, each with the sha256 of the
 * file and the mode git records for it (or, for a hook that is not the owner's, what it claims
 * to be: see ClaimedHook). One `version` and one `commit` at the top name the owner's
 * tag the whole lock was written from: a lock is delivered at one version or it is not delivered.
 *
 * Only the owner's write path writes it, and only where it already exists. A repository creates its
 * own lock, which is how it says what it takes; the owner never creates one.
 *
 * The hash is taken over the text `readShared` returns, so a checkout that differs only in line
 * endings hashes the same as the owner's copy. Every comparison in this subsystem reads through
 * that one function, and the lock has to agree with them.
 *
 * This file reads, validates and serialises. It decides nothing about which paths belong in a
 * lock: that is expected.ts.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import type { SharedCoreFile, SharedCoreGroup } from './manifest.ts';

import { readShared } from './owner.ts';

export const LOCK_FILE = 'smokestack.lock';
export const LOCK_OWNER = 'smokestack';

export interface HashedFile {
	/** The mode git records for the path in the repository that holds it: 100644 or 100755. */
	mode: string;
	sha256: string;
}

/** What a hook that is not the owner's says it is, in the classifier's own words (hook.ts). */
export type HookClaim = 'foreign-hook' | 'local-chain';
const CLAIMS: readonly string[] = ['foreign-hook', 'local-chain'];

/**
 * The entry for a group's hook where the file there is another tool's or a chain kept by hand.
 *
 * Such a hook is the repository's own and changes legitimately, so there is no hash and no mode to
 * hold it to. But recording NOTHING for it was a door: add the local-chain marker to a hook, gut
 * its body, delete its entry, and every check passed. So the hook's path always has an entry, and
 * when the hook is not the owner's the entry says which of the two it claimed to be at the last
 * write. Only the owner's write records one, from the file's content; both checks reclassify the
 * file and fail when the answer is no longer what is recorded.
 */
export interface ClaimedHook {
	claim: HookClaim;
}

export type LockedFile = ClaimedHook | HashedFile;

export type LockedFiles = Record<string, LockedFile>;

export function isClaim(entry: LockedFile): entry is ClaimedHook {
	return 'claim' in entry;
}

export interface Lock {
	/** The owner's commit the tag names. Present exactly when `version` is. */
	commit?: string;
	/** Group name to its recorded files, or null for a group declared and not yet delivered. */
	groups: Record<string, LockedFiles | null>;
	/** The owner's version this lock was written from. Absent until the first delivery. */
	version?: string;
}

function fail(path: string, message: string): never {
	throw new Error(`${path}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Refuses a key nothing reads, so a misspelt `file` cannot pass for a group with nothing in it. */
function onlyKeys(
	value: Record<string, unknown>,
	allowed: string[],
	path: string,
	where: string,
): void {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) fail(path, `${where} has unsupported key(s): ${unknown.join(', ')}.`);
}

function asFiles(raw: unknown, path: string, group: string): LockedFiles {
	if (!isRecord(raw)) fail(path, `group '${group}' files must be an object.`);
	const files: LockedFiles = {};
	for (const [installed, entry] of Object.entries(raw)) {
		const where = `group '${group}' file '${installed}'`;
		// The key is compared against paths this tool computes, so it has to be in the one spelling
		// the tool produces: relative, forward slashes, nothing to resolve.
		if (
			installed === '' ||
			installed !== posix.normalize(installed) ||
			installed.startsWith('/') ||
			installed.includes('\\') ||
			installed.split('/').includes('..')
		) {
			fail(path, `${where} is not a normalised relative path.`);
		}
		if (!isRecord(entry)) fail(path, `${where} must be an object.`);
		// Two shapes and no mixture: a claim beside a hash would say the file is and is not ours.
		if ('claim' in entry) {
			onlyKeys(entry, ['claim'], path, where);
			const { claim } = entry;
			if (typeof claim !== 'string' || !CLAIMS.includes(claim)) {
				fail(path, `${where} claim must be one of: ${CLAIMS.join(', ')}.`);
			}
			files[installed] = { claim: claim as HookClaim };
			continue;
		}
		onlyKeys(entry, ['mode', 'sha256'], path, where);
		const { mode, sha256 } = entry;
		if (mode !== '100644' && mode !== '100755')
			fail(path, `${where} mode must be a file mode.`);
		if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(sha256)) {
			fail(path, `${where} sha256 must be 64 hex characters.`);
		}
		files[installed] = { mode, sha256 };
	}
	return files;
}

function asLock(parsed: unknown, path: string): Lock {
	if (!isRecord(parsed)) fail(path, 'expected an object.');
	onlyKeys(parsed, ['commit', 'groups', 'owner', 'version'], path, 'the lock');
	if (parsed['owner'] !== LOCK_OWNER) fail(path, `owner must be '${LOCK_OWNER}'.`);

	const { commit, version } = parsed;
	if ((commit === undefined) !== (version === undefined)) {
		fail(path, 'version and commit are stated together, or neither is.');
	}
	if (
		version !== undefined &&
		(typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version))
	) {
		fail(path, 'version must be three numbers, as in 1.2.3.');
	}
	if (commit !== undefined && (typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit))) {
		fail(path, 'commit must be 40 hex characters.');
	}

	if (!isRecord(parsed['groups'])) fail(path, 'groups must be an object.');
	const groups: Lock['groups'] = {};
	for (const [name, raw] of Object.entries(parsed['groups'])) {
		if (!isRecord(raw)) fail(path, `group '${name}' must be an object.`);
		onlyKeys(raw, ['files'], path, `group '${name}'`);
		if (raw['files'] === undefined) {
			groups[name] = null;
			continue;
		}
		// Files with no version would be a delivery nobody can trace to a tag.
		if (version === undefined)
			fail(path, `group '${name}' records files but the lock no version.`);
		groups[name] = asFiles(raw['files'], path, name);
	}
	return {
		groups,
		...(typeof commit === 'string' && typeof version === 'string' ? { commit, version } : {}),
	};
}

/** The repository's lock, or null when it has none. Throws on a file it cannot vouch for. */
export function readLock(root: string): Lock | null {
	const path = join(root, LOCK_FILE);
	if (!existsSync(path)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, 'utf8'));
	} catch (err) {
		return fail(path, `is not JSON (${err instanceof Error ? err.message : String(err)}).`);
	}
	return asLock(parsed, path);
}

/**
 * The lock as it is written: objects only, keys sorted at every level, tabs, one trailing newline.
 * Sorted so that two writes of the same state produce the same bytes and a diff shows only what
 * changed.
 */
export function serializeLock(lock: Lock): string {
	const groups: Record<string, { files?: LockedFiles }> = {};
	for (const name of Object.keys(lock.groups).sort()) {
		const files = lock.groups[name];
		if (files === null || files === undefined) {
			groups[name] = {};
			continue;
		}
		const sorted: LockedFiles = {};
		for (const installed of Object.keys(files).sort()) {
			const entry = files[installed] as LockedFile;
			sorted[installed] = isClaim(entry)
				? { claim: entry.claim }
				: { mode: entry.mode, sha256: entry.sha256 };
		}
		groups[name] = { files: sorted };
	}
	const body = {
		...(lock.commit === undefined ? {} : { commit: lock.commit }),
		groups,
		owner: LOCK_OWNER,
		...(lock.version === undefined ? {} : { version: lock.version }),
	};
	return `${JSON.stringify(body, null, '\t')}\n`;
}

/** sha256 of a shared file's text, after the normalisation every comparison here applies. */
export function hashText(text: string): string {
	return createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex');
}

export function hashShared(path: string): string {
	return hashText(readShared(path));
}

/**
 * Where a group's file is installed, relative to the repository that holds it. This is the lock's
 * key. The source it came from is not recorded: it is found again through the manifest, from the
 * file's `target` and its variants.
 */
export function installedPath(group: SharedCoreGroup, file: SharedCoreFile): string {
	return posix.normalize(`${group.targetRoot}/${file.target ?? file.source}`);
}
