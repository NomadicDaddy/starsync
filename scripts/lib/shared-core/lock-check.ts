/**
 * The owner's view of a target's lock: two fatal findings the file comparison alone cannot make.
 *
 * `stale-lock`. A target whose files are all current and whose lock says otherwise is not drift,
 * and it is not clean either. The target's own gate reads the lock, so a lock left behind after a
 * delivery, or edited by hand, makes that gate fail (or pass) on a statement the files do not
 * support. It is unwritable by the file writer because it carries no destination; the write path
 * clears it by rewriting the lock once every group the target takes has been delivered. It is
 * judged only where the group is settled in that target: while a file there is absent, drifted or
 * a diverged hook, the lock cannot yet agree with anything, and the finding that already names the
 * file is the one to act on.
 *
 * `lost-delivery`. An absent file is normally a rollout gap, and a rollout gap does not fail the
 * check: the write path has not reached that target yet. That reading is wrong for a file the
 * target was already given. Its own gate is red for it, and for as long as the owner called the
 * same absence a gap, the gate that sweeps every consumer was green over a guard that had been
 * deleted. So where a target's lock records a delivery, a file of that delivery which is gone is
 * fatal here too. "Of that delivery" is read from two places, either of which is enough: the lock's
 * own entries, and the group's synced paths in this repository's manifest AT THE COMMIT THE LOCK
 * NAMES. The second is what catches a file removed together with its entry. A file the owner added
 * to the group after that commit was never delivered there, and stays a rollout gap.
 *
 * Both rest on the lock naming a delivery this repository really made, so that is verified first
 * against this repository's own tags, and a lock that fails it is fatal by that alone.
 *
 * All of that is inference from a file the target can rewrite, and some rewrites leave nothing to
 * infer from. So each target is first held to the owner's own record of what it delivered there
 * (delivery-check.ts), and what is inferred here is reported beside it.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Finding, FindingKind } from './check.ts';
import type { DeliveredTarget } from './deliveries.ts';
import type { SharedCoreGroup } from './manifest.ts';
import type { Target } from './targets.ts';

import { heldToRecord } from './delivery-check.ts';
import { groupState, lockDifferences } from './expected.ts';
import { hashShared, isClaim, type Lock, LOCK_FILE, type LockedFiles, readLock } from './lock.ts';
import { layoutPrefix } from './move.ts';
import { oldPathFindings } from './old-path.ts';
import { syncedPathsAt, verifyOrigin } from './origin.ts';

const UNSETTLED = new Set<FindingKind>(['diverged-hook', 'drift', 'uncovered']);

/** True when a finding means the group's files in that target are not yet what the owner holds. */
export function isUnsettled(finding: Finding): boolean {
	return UNSETTLED.has(finding.kind);
}

/**
 * Every path the lock's delivery gave the target for `group` that the target no longer holds, in
 * path order.
 *
 * WHERE THE LOCK NO LONGER RECORDS THE GROUP, whether its name was removed or its record was cut
 * back to a bare declaration, the history lookup is the only evidence left, and it has to be
 * asked: otherwise taking a whole group out of a delivered lock, with its files, skips every check
 * here, because there is no entry to compare and the absent files read as a gap. That is answered
 * for a DISCOVERED group only. A repository that keeps a lock takes every discovered group
 * (targets.ts), so if the group existed at the commit the lock names, that delivery included it.
 * A group reached through a roster cannot be answered this way: its absence from the lock, or a
 * bare declaration of it, may equally be a repository the roster started naming after that
 * delivery, and nothing here records which repositories a past write reached.
 */
function lostPaths(
	group: SharedCoreGroup,
	target: Target,
	ownerRoot: string,
	lock: Lock,
	recorded: LockedFiles | null | undefined,
): string[] {
	// A lock with no version has had no delivery at all.
	if (lock.commit === undefined) return [];
	const unrecorded = recorded === undefined || recorded === null;
	if (unrecorded && group.targets.model !== 'discovered') return [];

	const atCommit = syncedPathsAt(ownerRoot, lock.commit)?.get(group.name);
	const delivered = new Set([...Object.keys(recorded ?? {}), ...(atCommit ?? [])]);
	return [...delivered].filter((path) => !existsSync(join(target.path, path))).sort();
}

/**
 * The lock findings for one group in one target, or nothing: the target has no lock, or its lock
 * records exactly the files that apply, with the hook among them executable and none of them gone.
 *
 * `found` is what the check reported for this group in this target, which is how this knows
 * whether the comparison is settled without asking a second time.
 */
export function lockFindings(
	group: SharedCoreGroup,
	target: Target,
	ownerRoot: string,
	found: Finding[],
	entry: DeliveredTarget | undefined,
): Finding[] {
	const finding = (kind: FindingKind, detail: string): Finding => ({
		detail,
		group: group.name,
		kind,
		target: target.directory,
	});
	const gone = (path: string, version: string | undefined): Finding =>
		finding('lost-delivery', `${path} was delivered here at v${version} and is gone`);

	let lock: ReturnType<typeof readLock>;
	try {
		lock = readLock(target.path);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return [finding('stale-lock', `${LOCK_FILE} cannot be read: ${reason}`)];
	}
	// What the owner's own record says was delivered here, which no rewrite of the lock can take
	// back: delivery-check.ts. It is asked before anything is read out of the lock, and holds even
	// where the target has no lock left to read.
	const held = heldToRecord(group, target, lock, entry);
	if (lock === null) {
		return [...held.findings, ...held.lost.map((path) => gone(path, entry?.version))];
	}

	// First, whether the lock names a delivery this repository made at all. Everything below
	// reads history at the commit the lock names, so a lock pointed at a commit that is not here
	// would otherwise turn a lost file back into a rollout gap. A repository checking itself can
	// only ask this where the owner happens to be beside it, and has to allow that the owner is an
	// older checkout. Here the owner is asking about its own tags, so there is nothing to allow
	// for: a version it never tagged, or a tag that does not hold what the lock records, is a lock
	// no write of its produced. Reported under each group that reaches the target, like a lock
	// that cannot be read, and nothing else is judged against such a lock.
	if (lock.version !== undefined) {
		const origin = verifyOrigin(ownerRoot, lock);
		if (origin.state !== 'verified') {
			// Not `origin.reason`: that sentence is written for a repository looking at a
			// neighbour ("it may be an older checkout"), and this is the owner looking at itself.
			const why =
				origin.state === 'forged'
					? origin.findings.join('; ')
					: `this repository has no tag v${lock.version}`;
			return [
				finding(
					'stale-lock',
					`${LOCK_FILE} names v${lock.version}, which is not a delivery made from here: ${why}`,
				),
				...held.findings,
				...held.lost.map((path) => gone(path, entry?.version)),
			];
		}
	}

	const recorded = lock.groups[group.name];
	// A file lost by the record's account and by the lock's own is one lost file, reported once.
	const inferred = lostPaths(group, target, ownerRoot, lock, recorded);
	const lost = [...new Set([...inferred, ...held.lost])]
		.sort()
		.map((path) => gone(path, held.lost.includes(path) ? entry?.version : lock.version));

	// A lock recording this group in the folder a later release moved it out of is behind, not
	// drifted: the next write moves its files (move.ts). Its new paths read as a rollout gap
	// meanwhile, so this is asked before the unsettled files below end the comparison. The old
	// copies are still judged: one that is gone is lost, and one edited after delivery leaves the
	// lock describing a file that is not there, which the write refuses to move.
	const before =
		recorded === undefined || recorded === null ? null : layoutPrefix(group, recorded);
	if (before !== null) {
		const detail =
			`holds smokestack v${lock.version ?? '(none)'} with this group under ${before || './'}; ` +
			`this release installs it under ${group.targetRoot}/, and the next write moves it`;
		const edited = Object.entries(recorded ?? {}).flatMap(([path, delivered]) => {
			const at = join(target.path, path);
			if (isClaim(delivered) || !existsSync(at) || hashShared(at) === delivered.sha256)
				return [];
			const why = 'it was edited after delivery, so the next write will not move it';
			return [finding('stale-lock', `${LOCK_FILE} records ${path} as delivered, and ${why}`)];
		});
		return [...held.findings, ...lost, ...edited, finding('stale-layout', detail)];
	}
	// At the layout this release installs, a script or the group's hook can still name the old one.
	const reported =
		recorded === undefined || recorded === null
			? held.findings
			: [...held.findings, ...oldPathFindings(group, target, ownerRoot)];

	// Unsettled files leave the lock nothing to agree with yet; a lost delivery is reported anyway.
	if (lost.length > 0 || found.some(isUnsettled)) return [...reported, ...lost];

	if (recorded === undefined) {
		return [...reported, finding('stale-lock', `${LOCK_FILE} does not declare this group`)];
	}
	if (recorded === null) {
		const detail = `${LOCK_FILE} declares this group and records no delivery of it`;
		return [...reported, finding('stale-lock', detail)];
	}
	// The same comparison the target's own gate makes, so the two cannot disagree. It includes the
	// hook's mode: a lock that agrees with a hook git will not execute agrees with a guard that
	// is off.
	const differences = lockDifferences(group, recorded, groupState(group, target.path));
	if (differences.length === 0) return reported;
	const listed = differences.map(({ path, problem }) => `${path} ${problem}`).join('; ');
	return [
		...reported,
		finding('stale-lock', `${LOCK_FILE} disagrees with the files matched here: ${listed}`),
	];
}
