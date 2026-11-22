/**
 * Which locks a write may rewrite, decided before any file is written, so a refusal costs nothing.
 * Split out of lock-write.ts, which rewrites the locks this plans.
 *
 * A lock is planned only where a target already has one, and always at LOCK_FILE: a lock still at
 * the root, where v0.5.7 kept it, is read from there (move-home.ts removes the old one). A lock is
 * rewritten whole, at one version, so a write narrowed with `--group` is refused here unless the
 * lock is already at this version, rather than leaving a lock that claims one version for files
 * from two. A lock with uncommitted changes is refused at the same point, for the reason the file
 * writer refuses a file with them: the overwrite could not be undone.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { join } from 'node:path';

import type { GroupReport } from './check.ts';
import type { Deliveries } from './deliveries.ts';
import type { SharedCoreGroup } from './manifest.ts';
import type { Delivery } from './tag.ts';

import { installedPath, type Lock, LOCK_FILE, lockFileIn, readLock } from './lock.ts';
import { layoutPrefix } from './move.ts';
import { reachingGroups } from './reaching.ts';
import { describeUnmet, unmetRequirements } from './requires.ts';
import { idleRetirements, planDropped, planRetirements, type Retirement } from './retire.ts';
import { hasUncommittedChanges } from './write.ts';

interface PlannedLock {
	/** Groups the target takes that this run did not select; their entries are carried over. */
	carried: string[];
	directory: string;
	lock: Lock;
	path: string;
	/** Groups the target takes that this run delivers; their entries are recorded afresh. */
	taken: string[];
}

export interface LockPlan {
	/** Reasons no file may be written at all. Empty when the write may go ahead. */
	refusals: string[];
	/** In a rehearsal, targets refused here whose lock is readable, still planned further on. */
	rehearsed: string[];
	/** Groups leaving a repository on this run's --retire, removed once its lock is rewritten. */
	retired: Retirement[];
	targets: PlannedLock[];
}

/**
 * Every target this run reaches that has a lock, and every reason the run would leave one of those
 * locks saying something untrue. Computed before any file is written, so a refusal costs nothing.
 *
 * `all` is the whole manifest and `selected` the groups this run was narrowed to. A group outside
 * the selection was not compared, so whether it reaches a target is asked of its target model here.
 * `retiring` holds the groups this run was told to retire where they no longer reach (retire.ts).
 * A write stops a target at its first refusal; a `rehearsal` (a dry run) asks every later question
 * too, so one dry run names every blocker (delivery-dry-run-reports-every-blocker).
 */
export function planLocks(
	reports: GroupReport[],
	selected: SharedCoreGroup[],
	all: SharedCoreGroup[],
	fleetRoot: string,
	delivery: Delivery | null,
	retiring: Set<string>,
	deliveries: Deliveries,
	rehearsal = false,
): LockPlan {
	const plan: LockPlan = { refusals: [], rehearsed: [], retired: [], targets: [] };
	const chosen = new Set(selected.map((group) => group.name));
	// What a --retire matched (idleRetirements); only a target not refused retires (Roger, 3d44a8d).
	const matched: Retirement[] = [];

	for (const directory of [...new Set(reports.flatMap((report) => report.reached))].sort()) {
		const path = join(fleetRoot, directory);
		let lock: Lock | null;
		try {
			lock = readLock(path);
		} catch (err) {
			plan.refusals.push(err instanceof Error ? err.message : String(err));
			continue;
		}
		if (lock === null) continue;
		// Records refusals; a write stops at the first, a rehearsal asks on to name every blocker.
		let refused = false;
		const refuse = (reasons: string[]): boolean => {
			plan.refusals.push(...reasons);
			refused ||= reasons.length > 0;
			return refused && !rehearsal;
		};

		// Before the first file, not after: found afterwards, a lock with work in it kept its old
		// contents beside files that had already been replaced. Staged or not, tracked or not.
		let dirty: boolean;
		try {
			dirty = hasUncommittedChanges(path, lockFileIn(path) ?? LOCK_FILE);
		} catch (err) {
			plan.refusals.push(err instanceof Error ? err.message : String(err));
			continue;
		}
		const dirtyLock =
			`${directory}: its ${LOCK_FILE} has uncommitted changes, which rewriting it would ` +
			'destroy. Commit or discard them there. To write the other targets meanwhile, ' +
			'narrow with --only to leave this one out.';
		if (refuse(dirty ? [dirtyLock] : [])) continue;

		const reached = reachingGroups(directory, reports, all, fleetRoot);
		const reaching = reached.filter((name) => !retiring.has(name)); // --retire takes it out
		const declared = Object.keys(lock.groups).filter((name) => !reaching.includes(name));
		// A file a group still taken here installs is that group's now, whichever group it left.
		const installs = new Set(
			all
				.filter((group) => reaching.includes(group.name))
				.flatMap((group) => group.files.map((file) => installedPath(group, file))),
		);
		const leaving = planRetirements(
			{ declared, directory, entry: deliveries[directory], installs, lock, path },
			retiring,
		);
		const unreached =
			leaving.unreached.length === 0
				? []
				: [
						`${directory}: its ${LOCK_FILE} declares ${leaving.unreached.join(', ')}, which ` +
							'does not reach it from here. Writing the lock would drop what that repository ' +
							'declared. This stops the whole run: to write the other targets, narrow with ' +
							'--only to leave this one out. If it is leaving on purpose, forget it there and ' +
							'write with --only <directory> --retire <group>.',
					];
		if (refuse([...leaving.refusals, ...unreached])) continue;
		// A file a reaching group no longer installs anywhere, and is not moving to a new home, is
		// removed with the rewrite that stops the lock naming it.
		const moving = new Set(
			all
				.filter((group) => reaching.includes(group.name))
				.flatMap((group) => {
					const recorded = lock.groups[group.name];
					const prefix = recorded ? layoutPrefix(group, recorded) : null;
					return prefix === null
						? []
						: group.files.map((file) => `${prefix}${file.source}`);
				}),
		);
		// Only a group this run delivers: a group it was narrowed away from keeps its lock entry.
		const dropped = planDropped(
			{ declared, directory, entry: deliveries[directory], installs, lock, path },
			reaching.filter((name) => chosen.has(name)),
			moving,
		);
		if (refuse(dropped.refusals)) continue;
		const removals = [...leaving.retired, ...dropped.retired];
		if (!refused) matched.push(...removals);
		// A group delivered without what it requires is a tool that cannot do its first job.
		const unmet = unmetRequirements(all, reaching);
		const unmetRefusal =
			`${directory}: ${unmet.map(describeUnmet).join('; ')}, which does not reach it. ` +
			'Nothing is written there until it takes both. To write the other targets ' +
			'meanwhile, narrow with --only to leave this one out.';
		if (refuse(unmet.length > 0 ? [unmetRefusal] : [])) continue;
		const carried = reaching.filter((name) => !chosen.has(name));
		const current =
			delivery !== null &&
			lock.version === delivery.version &&
			lock.commit === delivery.commit;
		const narrowed =
			`${directory}: this write is narrowed with --group and does not deliver ` +
			`${carried.join(', ')}, which that repository also takes. Its ${LOCK_FILE} would ` +
			'name one version for files from two. Write every group it takes instead: ' +
			`bun run shared-core:write --only ${directory}`;
		if (refuse(carried.length > 0 && !current ? [narrowed] : [])) continue;
		if (refused) {
			plan.rehearsed.push(directory);
			continue;
		}
		plan.retired.push(...removals);
		const taken = reaching.filter((name) => chosen.has(name));
		plan.targets.push({ carried, directory, lock, path, taken });
	}
	plan.refusals.push(...idleRetirements(retiring, matched));
	return plan;
}
