/**
 * Whether a lock's hashes are what the owner's tag really holds.
 *
 * A repository alone can show that its files match its lock. It cannot show where either came
 * from: whoever edits a file can edit the hash beside it. Where the owner is checked out beside
 * the repository, this closes that, by reading each recorded file out of the owner's GIT HISTORY at
 * the commit the lock names. Never its working tree, which is whatever its owner is in the middle
 * of.
 *
 * The source of an installed path is found through the manifest as it stood at that commit: the
 * group's file entry, its `target`, and its variants. Either declared variant is a match, since
 * which one a repository is due depends on its own package.json.
 *
 * Three outcomes, and the difference between the first two is the point. An owner that does not
 * have the tag and has none newer is probably an older checkout: nothing can be verified against
 * it, and nothing is wrong. A tag that exists and does not hold a recorded hash, or a missing tag
 * below one the owner does have, is a lock that is forged or mistaken.
 */
import { posix } from 'node:path';

import { syncedPaths } from './expected.ts';
import { hashText, installedPath, isClaim, type Lock, LOCK_FILE } from './lock.ts';
import { parseManifest, type SharedCoreGroup } from './manifest.ts';
import { sourcesOf } from './owner.ts';

export type Origin =
	| { behind: null | string; state: 'verified' }
	| { findings: string[]; state: 'forged' }
	| { reason: string; state: 'unverified' };

const answered = new Map<string, Buffer | null>();

/**
 * Every question asked here reads the owner's history (tags, and files at a tagged commit), which
 * does not change while one sweep runs, so each is answered once per process. The owner's sweep
 * verifies every target's lock and most name the same tag; asking git again for each of them was
 * over half of the whole check's time.
 */
function git(root: string, args: string[], stdin?: string): Buffer | null {
	const key = JSON.stringify([root, args, stdin ?? null]);
	if (answered.has(key)) return answered.get(key) ?? null;
	const result = Bun.spawnSync(['git', '-C', root, ...args], {
		stderr: 'pipe',
		stdout: 'pipe',
		windowsHide: true,
		...(stdin === undefined ? {} : { stdin: Buffer.from(stdin) }),
	});
	const out = result.exitCode === 0 ? Buffer.from(result.stdout) : null;
	answered.set(key, out);
	return out;
}

/**
 * The text of each `<rev>:<path>` asked for, in one git process, or null where that revision has no
 * such file. One process because a lock records every file a repository takes, and a process per
 * file is what makes a gate slow enough to be skipped.
 */
function showAll(ownerRoot: string, rev: string, paths: string[]): Map<string, null | string> {
	const shown = new Map<string, null | string>();
	const out = git(
		ownerRoot,
		['cat-file', '--batch'],
		paths.map((path) => `${rev}:${path}\n`).join(''),
	);
	if (out === null) throw new Error(`git could not read ${rev} in ${ownerRoot}.`);

	let at = 0;
	for (const path of paths) {
		const end = out.indexOf('\n', at);
		const header = out.subarray(at, end).toString();
		at = end + 1;
		// `<name> missing` for a path the revision does not hold; `<sha> <type> <size>` otherwise.
		const size = /^[0-9a-f]+ blob (\d+)$/u.exec(header)?.[1];
		if (size === undefined) {
			shown.set(path, null);
			continue;
		}
		shown.set(path, out.subarray(at, at + Number(size)).toString());
		at += Number(size) + 1;
	}
	return shown;
}

const MANIFEST_PATH = 'scripts/shared-core-manifest.json';
const pathsAt = new Map<string, Map<string, string[]> | null>();

/**
 * Each group's synced installed paths as the owner's manifest stood at `rev`: what a delivery made
 * from that commit consisted of. Null when that revision is not in this repository or holds no
 * manifest. Remembered per revision, because the owner's sweep asks once for every group of every
 * target and most locks name the same commit.
 */
export function syncedPathsAt(ownerRoot: string, rev: string): Map<string, string[]> | null {
	const key = `${ownerRoot}\n${rev}`;
	const known = pathsAt.get(key);
	if (known !== undefined) return known;

	const manifest = showAll(ownerRoot, rev, [MANIFEST_PATH]).get(MANIFEST_PATH);
	const paths =
		manifest === null || manifest === undefined
			? null
			: new Map(
					parseManifest(manifest).map((group) => [
						group.name,
						syncedPaths(group).map((synced) => synced.path),
					]),
				);
	pathsAt.set(key, paths);
	return paths;
}

/**
 * For every synced installed path the owner delivers at `rev`, the hashes it may hold there: one
 * per declared variant. Null when that revision has no readable manifest.
 */
function deliveredAt(ownerRoot: string, rev: string): Map<string, Set<string>> | null {
	const manifest = showAll(ownerRoot, rev, [MANIFEST_PATH]).get(MANIFEST_PATH);
	if (manifest === null || manifest === undefined) return null;

	const sources = new Map<string, string[]>();
	for (const group of parseManifest(manifest)) {
		for (const { file, path } of syncedPaths(group)) {
			const variants = sourcesOf(file).map((s) =>
				posix.normalize(`${group.sourceRoot}/${s}`),
			);
			sources.set(`${group.name}\n${path}`, variants);
		}
	}
	const texts = showAll(ownerRoot, rev, [...new Set([...sources.values()].flat())]);
	const delivered = new Map<string, Set<string>>();
	for (const [key, variants] of sources) {
		const hashes = variants.flatMap((variant) => {
			const text = texts.get(variant);
			return text === null || text === undefined ? [] : [hashText(text)];
		});
		delivered.set(key, new Set(hashes));
	}
	return delivered;
}

/**
 * Every hashed entry whose hash `delivered` does not hold. A claim entry is skipped: it records a
 * hook that is the repository's own, and the tag holds nothing to compare it with.
 */
function unmatched(lock: Lock, delivered: Map<string, Set<string>>): string[] {
	const missing: string[] = [];
	for (const [group, files] of Object.entries(lock.groups)) {
		for (const [path, entry] of Object.entries(files ?? {})) {
			if (isClaim(entry)) continue;
			if (delivered.get(`${group}\n${path}`)?.has(entry.sha256) !== true) {
				missing.push(`${path}:0 is not what the tag holds for group '${group}'`);
			}
		}
	}
	return missing;
}

function versionOf(tag: string): null | number[] {
	const match = /^v(\d+)\.(\d+)\.(\d+)$/u.exec(tag);
	return match === null ? null : match.slice(1).map(Number);
}

function newer(a: number[], b: number[]): boolean {
	for (const [index, part] of a.entries()) {
		if (part !== (b[index] ?? 0)) return part > (b[index] ?? 0);
	}
	return false;
}

/** Thrown when git cannot list the owner's tags, which is not the same as there being none. */
class TagListUnreadable extends Error {}

/** The owner's highest version tag above `version`, or null when the lock is at the newest. */
function newestTagAbove(ownerRoot: string, version: string): null | string {
	const mine = versionOf(`v${version}`) ?? [];
	let newest: null | string = null;
	const listed = git(ownerRoot, ['tag', '--list', 'v*']);
	if (listed === null) throw new TagListUnreadable(`git could not read the tags in ${ownerRoot}`);
	for (const tag of listed.toString().split('\n')) {
		const candidate = versionOf(tag.trim());
		if (candidate === null || !newer(candidate, mine)) continue;
		if (newest === null || newer(candidate, versionOf(newest) ?? [])) newest = tag.trim();
	}
	return newest;
}

/** Each tag's manifest as parsed, remembered like every other answer here. */
const groupsAt = new Map<string, SharedCoreGroup[]>();

/**
 * Every path a tagged release of the owner installed `group` at, read from each tag's manifest:
 * seeded files as well as synced ones, since a move renames a seeded file too, and the most
 * referenced file in the fleet (run-bash.ts) is seeded. A tag list git cannot read throws rather
 * than reading as no releases.
 */
export function taggedPaths(ownerRoot: string, group: string): Set<string> {
	const listed = git(ownerRoot, ['tag', '--list', 'v*']);
	if (listed === null) throw new TagListUnreadable(`git could not read the tags in ${ownerRoot}`);
	const paths = new Set<string>();
	for (const tag of listed
		.toString()
		.split('\n')
		.map((line) => line.trim())) {
		if (versionOf(tag) === null) continue;
		const key = `${ownerRoot}\n${tag}`;
		let groups = groupsAt.get(key);
		if (groups === undefined) {
			const manifest = showAll(ownerRoot, `refs/tags/${tag}`, [MANIFEST_PATH]).get(
				MANIFEST_PATH,
			);
			groups = manifest === null || manifest === undefined ? [] : parseManifest(manifest);
			groupsAt.set(key, groups);
		}
		const then = groups.find((candidate) => candidate.name === group);
		if (then === undefined) continue;
		for (const file of then.files) paths.add(installedPath(then, file));
	}
	return paths;
}

/**
 * Verifies a delivered lock against the owner checked out at `ownerRoot`. A tag list git cannot
 * read leaves the lock unverified with that reason, never with the older-checkout reason that an
 * empty list would produce, since it may be hiding a newer tag that makes the lock forged.
 */
export function verifyOrigin(ownerRoot: string, lock: Lock): Origin {
	try {
		return verifyOriginAt(ownerRoot, lock);
	} catch (err) {
		if (err instanceof TagListUnreadable) return { reason: err.message, state: 'unverified' };
		throw err;
	}
}

function verifyOriginAt(ownerRoot: string, lock: Lock): Origin {
	const tag = `v${lock.version}`;
	if (git(ownerRoot, ['rev-parse', '--git-dir']) === null) {
		return { reason: `${ownerRoot} is not a git repository`, state: 'unverified' };
	}
	const named = git(ownerRoot, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
	if (named === null) {
		// An older checkout lacks the tag because it has not fetched that far, so it cannot hold a
		// version above it either. One that does hold a newer tag is not behind: the version the
		// lock names was never cut, and a lock naming it is not a delivery.
		const above = newestTagAbove(ownerRoot, lock.version as string);
		if (above !== null) {
			const finding =
				`${LOCK_FILE}:0 names ${tag}, which this smokestack does not have although it has ` +
				`${above}: no such version was delivered`;
			return { findings: [finding], state: 'forged' };
		}
		return {
			reason: `this smokestack does not have tag ${tag}; it may be an older checkout`,
			state: 'unverified',
		};
	}
	const commit = named.toString().trim();
	if (commit !== lock.commit) {
		return {
			findings: [`${LOCK_FILE}:0 names commit ${lock.commit} for ${tag}, which is ${commit}`],
			state: 'forged',
		};
	}
	const delivered = deliveredAt(ownerRoot, commit);
	if (delivered === null) {
		return {
			findings: [`${LOCK_FILE}:0 names ${tag}, which holds no manifest`],
			state: 'forged',
		};
	}
	const findings = unmatched(lock, delivered);
	if (findings.length > 0) return { findings, state: 'forged' };

	// Behind is the owner having moved on, not this repository being wrong. It is reported and
	// does not fail: when to take a delivery is the repository's decision.
	const newest = newestTagAbove(ownerRoot, lock.version as string);
	if (newest === null) return { behind: null, state: 'verified' };
	let changed: number;
	try {
		const ahead = deliveredAt(ownerRoot, newest);
		changed = ahead === null ? 0 : unmatched(lock, ahead).length;
	} catch {
		// A later manifest may hold something this copy of the tool does not know how to read.
		const behind = `smokestack has ${newest}, whose manifest this copy of the sync cannot read`;
		return { behind, state: 'verified' };
	}
	if (changed === 0) return { behind: null, state: 'verified' };
	return {
		behind: `smokestack has ${newest}, which changes ${changed} recorded file(s)`,
		state: 'verified',
	};
}
