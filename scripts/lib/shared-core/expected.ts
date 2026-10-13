/**
 * Which of a group's files a repository's lock records, what it records for each, and how a lock is
 * held to that.
 *
 * One function answers this for the owner's write, the owner's check and a repository checking
 * itself, because a lock written by one rule and verified by another is red for no reason anyone
 * can find. The rule:
 *
 * - Every file the manifest marks `synced`, and no other. A `seeded` file is written once and is
 *   then the repository's own, so it legitimately differs and is never recorded or compared.
 * - For each, its hash and the mode git holds. The one exception is the group's hook where the
 *   file there is another tool's or a chain kept by hand: that is recorded as the claim its own
 *   content makes (see ClaimedHook in lock.ts), never as nothing.
 *
 * EVERY INPUT IS TRACKED: the manifest and the content of the files. What git dispatches in a clone
 * (`core.hooksPath`, a hook under `.git/hooks`, another tool running hooks) plays no part, because
 * it is not part of a repository and differs between two clones of the same commit. A set that read
 * it gave one answer on the machine that wrote the lock and another in a fresh clone, and the only
 * way to make both pass was to stop requiring the hook files, which let a guard be gutted and its
 * entry deleted together. So the set is the same in the owner's sweep, in a clone that dispatches
 * the hook and in one that does not, and it is EXACT in all three. Which guards the hook chains
 * does not enter it either: every synced file of the group is recorded, chained or not.
 *
 * Nothing here opens the owner. The hook's variants and the owner's history are what check.ts uses
 * to tell drift from a diverged hook; a lock is only ever written where that is already settled.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { SharedCoreFile, SharedCoreGroup } from './manifest.ts';

import { hookClaim } from './hook.ts';
import { hashShared, installedPath, isClaim, type LockedFile, type LockedFiles } from './lock.ts';
import { readShared } from './owner.ts';

/** The only mode git will execute a hook from on Linux or macOS. */
const EXECUTABLE = '100755';

export interface SyncedPath {
	file: SharedCoreFile;
	/** Installed path relative to the repository root: the lock's key. */
	path: string;
}

/** One way a lock and the tree beside it disagree. `problem` reads on after the path. */
export interface Difference {
	path: string;
	problem: string;
}

/** What each synced path of a group holds in one repository, or null where the file is absent. */
export type GroupState = Record<string, LockedFile | null>;

/** Every file the group keeps current, by installed path. This is the set a lock records. */
export function syncedPaths(group: SharedCoreGroup): SyncedPath[] {
	return group.files
		.filter((file) => file.disposition === 'synced')
		.map((file) => ({ file, path: installedPath(group, file) }));
}

function hookPath(group: SharedCoreGroup): string | undefined {
	return syncedPaths(group).find(({ file }) => (file.target ?? file.source) === group.hook)?.path;
}

/**
 * The mode git records for each path: the index entry where the path is tracked, and otherwise the
 * mode git would give it when added.
 *
 * The index, not the filesystem, because the repositories this runs in set `core.fileMode=false`
 * on Windows: the mode on disk says nothing there, and the index entry is the only part that
 * survives a clone. A path git does not track yet has no entry, which is every file a write has
 * just delivered for the first time. For those the answer is what `git add` will record: the
 * executable bit on disk where git reads it, and 100644 where `core.fileMode` is false.
 */
export function gitModes(root: string, paths: string[]): Map<string, string> {
	const modes = new Map<string, string>();
	if (paths.length === 0) return modes;

	const listed = Bun.spawnSync(['git', '-C', root, 'ls-files', '-s', '-z', '--', ...paths], {
		stderr: 'pipe',
		stdout: 'pipe',
		windowsHide: true,
	});
	if (listed.exitCode !== 0) {
		const detail = listed.stderr.toString().trim();
		throw new Error(`git could not list file modes in ${root}.${detail ? ` ${detail}` : ''}`);
	}
	for (const record of listed.stdout.toString().split('\0')) {
		const tab = record.indexOf('\t');
		if (tab === -1) continue;
		modes.set(record.slice(tab + 1), record.slice(0, 6));
	}

	const untracked = paths.filter((path) => !modes.has(path));
	if (untracked.length === 0) return modes;
	const fileMode = Bun.spawnSync(['git', '-C', root, 'config', '--get', 'core.fileMode'], {
		stderr: 'pipe',
		stdout: 'pipe',
		windowsHide: true,
	});
	const readsDisk = fileMode.stdout.toString().trim() !== 'false';
	for (const path of untracked) {
		const executable = readsDisk && (statSync(join(root, path)).mode & 0o111) !== 0;
		modes.set(path, executable ? '100755' : '100644');
	}
	return modes;
}

/**
 * What the repository at `root` holds for every synced path of `group`: the entry a write would
 * record for it now. An absent file is null, the hook included: absence claims nothing, so an
 * absent hook is still the group's to deliver and still required.
 */
export function groupState(group: SharedCoreGroup, root: string): GroupState {
	const hook = hookPath(group);
	const paths = syncedPaths(group).map((synced) => synced.path);
	const present = paths.filter((path) => existsSync(join(root, path)));
	const modes = gitModes(root, present);

	const state: GroupState = {};
	for (const path of paths) {
		if (!present.includes(path)) {
			state[path] = null;
			continue;
		}
		const claim = path === hook ? hookClaim(group, readShared(join(root, path))) : 'ours';
		state[path] =
			claim === 'ours'
				? { mode: modes.get(path) as string, sha256: hashShared(join(root, path)) }
				: { claim };
	}
	return state;
}

/**
 * What is wrong with the mode of the group's hook in `state`, or null.
 *
 * The hook is the one file git executes itself, and it will not run a hook that is not executable.
 * The guards a hook runs are started through bash, so their mode decides nothing and each keeps
 * whatever its repository has. A hook held as 100644 is therefore a guard that is silently off in
 * every clone on Linux or macOS, however current its bytes are. A hook that is not the owner's is
 * not held to this: its mode is its repository's business.
 *
 * PLATFORM LIMIT. On Windows git runs a hook whatever its mode and `core.fileMode` is false, so
 * nothing on that machine shows the defect; the index entry is the only place it exists. That is
 * why this reads the mode `gitModes` reports and not the disk, and why a hook git does not track
 * yet reads as 100644 there until it is added with the bit set. The repair is made in the
 * repository that holds the hook.
 */
export function hookModeDefect(group: SharedCoreGroup, state: GroupState): Difference | null {
	const path = hookPath(group);
	const entry = path === undefined ? undefined : state[path];
	if (path === undefined || entry === undefined || entry === null || isClaim(entry)) return null;
	if (entry.mode === EXECUTABLE) return null;
	return {
		path,
		problem:
			`is the hook git executes and is mode ${entry.mode}, not ${EXECUTABLE} ` +
			`(there: git update-index --chmod=+x ${path})`,
	};
}

function compare(was: LockedFile | undefined, is: LockedFile | null): null | string {
	if (is === null)
		return was === undefined ? 'is not here and has no entry' : 'is recorded and is not here';
	if (was === undefined) return 'has no entry';
	if (isClaim(was)) {
		if (!isClaim(is)) return `is recorded as ${was.claim} and its content no longer says so`;
		if (is.claim === was.claim) return null;
		return `is recorded as ${was.claim} and its content now says ${is.claim}`;
	}
	if (isClaim(is)) return `is recorded as the owner's and its content now says ${is.claim}`;
	if (was.sha256 !== is.sha256) return 'differs from the hash recorded for it';
	if (was.mode !== is.mode) return `is mode ${is.mode} in git and recorded as ${was.mode}`;
	return null;
}

/**
 * Every way `recorded` is not exactly what `state` holds, in path order: an entry missing, an entry
 * for a path the group does not deliver, a file gone, a hash or a mode that differs, a claim that
 * the hook's content no longer makes, and a hook git will not execute.
 */
export function lockDifferences(
	group: SharedCoreGroup,
	recorded: LockedFiles,
	state: GroupState,
): Difference[] {
	const differences: Difference[] = [];
	for (const path of [...new Set([...Object.keys(recorded), ...Object.keys(state)])].sort()) {
		const is = state[path];
		const problem =
			is === undefined
				? `is recorded under '${group.name}', which does not deliver it`
				: compare(recorded[path], is);
		if (problem !== null) differences.push({ path, problem });
	}
	const mode = hookModeDefect(group, state);
	return mode === null ? differences : [...differences, mode];
}
