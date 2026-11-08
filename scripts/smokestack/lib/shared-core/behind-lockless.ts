/**
 * A copy an installer put in a repository the writer has never delivered to can lag the owner
 * without being altered, as a locked delivery can (behind.ts).
 *
 * Such a repository has no lock, so nothing records which release its copies came from, and every
 * release that changed one of them used to fail on it until the copy was replaced: 0.6.8 needed
 * fourteen known-drift entries for one guard. Its group reads as behind only when ALL of these
 * hold, and its differing files then say which tag they match:
 *
 * - The owner's record of deliveries for this fleet root was read and has no entry for it, so the
 *   writer has never delivered there (check.ts). A missing record grants nothing.
 * - It holds no lock and its own history never tracked one, at either lock path. A repository that
 *   was delivered to, lost its lock and was then forgotten (deliveries:forget) has a lock in its
 *   history. Rewriting that history away is two deliberate acts, and is the accepted residual.
 * - The whole group is the PREVIOUS RELEASE: every synced path the owner's manifest gave the group
 *   at that tag is present and holds one of the tag's variants of that file, or is the group's hook
 *   holding a chain that is the repository's own. A file missing, a file from another release, or
 *   a group mixing releases is drift, as for a locked repository.
 *
 * The previous release is one tag for the whole run, never searched for per file. Where the owner's
 * HEAD is a v* tag and no tracked file differs from it, the release being checked is that tag, and
 * the previous release is the v* tag before it. Otherwise (an untagged release commit, or tracked
 * changes on a tagged HEAD) the release being checked is unreleased, and the previous release is
 * the newest v* tag reachable from HEAD. An untracked file in the owner changes nothing here.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { existsSync } from 'node:fs';
import { join, posix, relative } from 'node:path';

import type { Finding } from './check.ts';
import type { SharedCoreGroup } from './manifest.ts';
import type { Target } from './targets.ts';

import { hookClaim } from './hook.ts';
import { hashShared, LOCK_FILE, PREVIOUS_LOCK_FILE } from './lock.ts';
import { deliveredAt, syncedPathsAt } from './origin.ts';
import { readShared } from './owner.ts';

function git(root: string, args: string[]): null | string {
	const result = Bun.spawnSync(['git', '-C', root, ...args], {
		stderr: 'pipe',
		stdout: 'pipe',
		windowsHide: true,
	});
	return result.exitCode === 0 ? result.stdout.toString() : null;
}

function lines(text: null | string): string[] {
	return (text ?? '')
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '');
}

const previousTags = new Map<string, null | string>();

/** The release before the one being checked (see the header), or null where there is none. */
export function previousReleaseTag(ownerRoot: string): null | string {
	const cached = previousTags.get(ownerRoot);
	if (cached !== undefined) return cached;
	const tags = lines(
		git(ownerRoot, ['tag', '--merged', 'HEAD', '--list', 'v*', '--sort=-v:refname']),
	);
	const atHead = new Set(lines(git(ownerRoot, ['tag', '--points-at', 'HEAD', '--list', 'v*'])));
	const changes = git(ownerRoot, ['status', '--porcelain', '--untracked-files=no']);
	const released = atHead.size > 0 && changes !== null && changes.trim() === '';
	const previous = (released ? tags.find((tag) => !atHead.has(tag)) : tags[0]) ?? null;
	previousTags.set(ownerRoot, previous);
	return previous;
}

const lockHistory = new Map<string, boolean>();

/**
 * Whether the repository's own history has ever tracked a lock, at either path. Asked once per
 * repository, not once per group (Morticia, 4d81097 review).
 */
function everLocked(root: string): boolean {
	const cached = lockHistory.get(root);
	if (cached !== undefined) return cached;
	const log = git(root, [
		'log',
		'--all',
		'--format=%H',
		'-1',
		'--',
		LOCK_FILE,
		PREVIOUS_LOCK_FILE,
	]);
	// A history git cannot read is not evidence of never: it grants nothing.
	const locked = log === null || log.trim() !== '';
	lockHistory.set(root, locked);
	return locked;
}

/** Whether every file the group held at `tag` is here as one of that tag's variants. */
function wholeGroupAt(
	group: SharedCoreGroup,
	target: Target,
	ownerRoot: string,
	tag: string,
): boolean {
	const paths = syncedPathsAt(ownerRoot, tag)?.get(group.name);
	const delivered = deliveredAt(ownerRoot, tag);
	if (!paths || paths.length === 0 || delivered === null) return false;
	const hook = group.hook === undefined ? null : posix.join(group.targetRoot, group.hook);
	return paths.every((path) => {
		const here = join(target.path, path);
		if (!existsSync(here)) return false;
		if (path === hook && hookClaim(group, readShared(here)) !== 'ours') return true;
		return delivered.get(`${group.name}\n${path}`)?.has(hashShared(here)) === true;
	});
}

/** The group's drift in a lockless, never-delivered repository, as behind where the header allows. */
export function locklessBehind(
	group: SharedCoreGroup,
	target: Target,
	ownerRoot: string,
	findings: Finding[],
): Finding[] {
	const tag = previousReleaseTag(ownerRoot);
	if (tag === null || everLocked(target.path)) return findings;
	if (!wholeGroupAt(group, target, ownerRoot, tag)) return findings;
	const paths = syncedPathsAt(ownerRoot, tag)?.get(group.name) ?? [];
	const commit = (git(ownerRoot, ['rev-parse', `${tag}^{commit}`]) ?? '').trim().slice(0, 8);
	return findings.map((finding): Finding => {
		if (finding.kind !== 'drift' || finding.destination === undefined) return finding;
		const path = relative(target.path, finding.destination).replaceAll('\\', '/');
		if (!paths.includes(path)) return finding;
		return {
			...finding,
			detail: `${finding.detail}; matches ${tag} (${commit}), the release before the one being checked, with no recorded delivery or lock history, so delivery is behind`,
			kind: 'behind',
		};
	});
}
