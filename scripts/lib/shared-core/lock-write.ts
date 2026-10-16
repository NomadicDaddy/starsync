/**
 * The two things a write owes a lock: a tagged version to name, and the lock itself.
 *
 * A TAG, because a lock that names a version has to name something that can be found again. A write
 * is made only while the owner's HEAD is exactly the annotated tag `v<package.json version>`, no
 * tracked file is modified or staged, and every source file the manifest names is tracked, so the
 * bytes delivered are the bytes that commit holds. A source that exists on disk but was never
 * committed would otherwise be delivered from the working tree and its lock read as forged against
 * the tag. Other untracked files do not block it: nothing delivers them. The tag is cut
 * before the write and before any target's gate has run on those bytes, so it marks a delivery, not
 * a verified one.
 *
 * THE LOCK, written only where a target already has one. It is rewritten whole, at one version, once
 * every group the target takes has been delivered there with nothing refused. A write narrowed with
 * `--group` cannot do that unless the lock is already at this version, so it is refused before any
 * file is written rather than leaving a lock that claims one version for files from two. A lock
 * with uncommitted changes is refused at the same point, for the reason the file writer refuses a
 * file with them: the overwrite could not be undone.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GroupReport } from './check.ts';
import type { Deliveries } from './deliveries.ts';
import type { SharedCoreGroup } from './manifest.ts';
import type { WriteOutcome } from './write.ts';

import { unrecordedClaims } from './delivery-check.ts';
import { groupState, hookModeDefect } from './expected.ts';
import { isUnsettled } from './lock-check.ts';
import { type Lock, LOCK_FILE, type LockedFiles, readLock, serializeLock } from './lock.ts';
import { reachingGroups } from './reaching.ts';
import { describeUnmet, unmetRequirements } from './requires.ts';
import { hasUncommittedChanges } from './write.ts';

/** The tag a write is made from: the owner's version and the commit its tag names. */
export interface Delivery {
	commit: string;
	version: string;
}

function git(root: string, ...args: string[]): null | string {
	const result = Bun.spawnSync(['git', '-C', root, ...args], {
		stderr: 'pipe',
		stdout: 'pipe',
		windowsHide: true,
	});
	return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

/** The delivery a write from `root` would name, or the reason it may not be made from here. */
export function tagStanding(root: string): { delivery: Delivery } | { refusal: string } {
	let version: unknown;
	try {
		const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as unknown;
		version = (manifest as { version?: unknown } | null)?.version;
	} catch {
		version = undefined;
	}
	if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)) {
		return { refusal: `package.json in ${root} states no version of the form 1.2.3` };
	}
	const tag = `v${version}`;
	const kind = git(root, 'cat-file', '-t', `refs/tags/${tag}`);
	if (kind === null)
		return { refusal: `there is no tag ${tag} for the version package.json states` };
	// A lightweight tag is a second name for a commit and nothing more: it records no tagger and
	// no date, and moving it leaves no trace.
	if (kind !== 'tag') return { refusal: `${tag} is not an annotated tag` };

	const named = git(root, 'rev-parse', `${tag}^{commit}`);
	const head = git(root, 'rev-parse', 'HEAD');
	if (named === null || head === null) return { refusal: `git could not resolve ${tag} or HEAD` };
	if (named !== head) return { refusal: `HEAD is not the commit ${tag} names` };

	const changed = git(root, 'status', '--porcelain', '--untracked-files=no');
	if (changed === null) return { refusal: 'git could not report the state of the working tree' };
	if (changed !== '') {
		const count = changed.split('\n').length;
		return {
			refusal: `${count} tracked file(s) are modified or staged, so HEAD is not what is here`,
		};
	}
	return { delivery: { commit: head, version } };
}

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
	targets: PlannedLock[];
}

/**
 * Every target this run reaches that has a lock, and every reason the run would leave one of those
 * locks saying something untrue. Computed before any file is written, so a refusal costs nothing.
 *
 * `all` is the whole manifest and `selected` the groups this run was narrowed to. A group outside
 * the selection was not compared, so whether it reaches a target is asked of its target model here.
 */
export function planLocks(
	reports: GroupReport[],
	selected: SharedCoreGroup[],
	all: SharedCoreGroup[],
	fleetRoot: string,
	ownerRoot: string,
	delivery: Delivery | null,
): LockPlan {
	const plan: LockPlan = { refusals: [], targets: [] };
	const chosen = new Set(selected.map((group) => group.name));

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

		// Before the first file, not after: found afterwards, a lock with work in it kept its old
		// contents beside files that had already been replaced. Staged or not, tracked or not.
		let dirty: boolean;
		try {
			dirty = hasUncommittedChanges(path, LOCK_FILE);
		} catch (err) {
			plan.refusals.push(err instanceof Error ? err.message : String(err));
			continue;
		}
		if (dirty) {
			plan.refusals.push(
				`${directory}: its ${LOCK_FILE} has uncommitted changes, which rewriting it would ` +
					'destroy. Commit or discard them there. To write the other targets meanwhile, ' +
					'narrow with --only to leave this one out.',
			);
			continue;
		}

		const reaching = reachingGroups(directory, reports, all, fleetRoot, ownerRoot);
		const unreached = Object.keys(lock.groups).filter((name) => !reaching.includes(name));
		if (unreached.length > 0) {
			plan.refusals.push(
				`${directory}: its ${LOCK_FILE} declares ${unreached.join(', ')}, which does not ` +
					'reach it from here. Writing the lock would drop what that repository declared. ' +
					'This stops the whole run: to write the other targets, narrow with --only to ' +
					'leave this one out.',
			);
			continue;
		}
		// A group delivered without what it requires is a tool that cannot do its first job.
		const unmet = unmetRequirements(all, reaching);
		if (unmet.length > 0) {
			plan.refusals.push(
				`${directory}: ${unmet.map(describeUnmet).join('; ')}, which does not reach it. ` +
					'Nothing is written there until it takes both. To write the other targets ' +
					'meanwhile, narrow with --only to leave this one out.',
			);
			continue;
		}
		const carried = reaching.filter((name) => !chosen.has(name));
		const current =
			delivery !== null &&
			lock.version === delivery.version &&
			lock.commit === delivery.commit;
		if (carried.length > 0 && !current) {
			plan.refusals.push(
				`${directory}: this write is narrowed with --group and does not deliver ` +
					`${carried.join(', ')}, which that repository also takes. Its ${LOCK_FILE} would ` +
					'name one version for files from two. Write every group it takes instead: ' +
					`bun run shared-core:write --only ${directory}`,
			);
			continue;
		}
		const taken = reaching.filter((name) => chosen.has(name));
		plan.targets.push({ carried, directory, lock, path, taken });
	}
	return plan;
}

export interface LockOutcome {
	/**
	 * Each target whose lock now holds exactly this delivery, with ONLY the groups this run
	 * delivered and compared. A group the run was narrowed away from is carried in the lock from
	 * the target's own copy, which is the target's word and not what the owner records.
	 */
	settled: Map<string, Lock>;
	/** Targets whose lock was left as it was, each with the reason. */
	withheld: string[];
	/** Targets whose lock was rewritten, or would be on a real run. */
	written: string[];
}

/**
 * Rewrites the lock of every planned target whose groups were all delivered. `outcomes` is what the
 * file writer did, one per selected group; a target with a file refused, or a hook only a person
 * can settle, keeps the lock it had, because nothing true could be written over it yet.
 */
export function writeLocks(
	plan: LockPlan,
	outcomes: Map<string, WriteOutcome>,
	selected: SharedCoreGroup[],
	delivery: Delivery | null,
	dryRun: boolean,
	deliveries: Deliveries,
): LockOutcome {
	const result: LockOutcome = { settled: new Map(), withheld: [], written: [] };

	for (const { carried, directory, lock, path, taken } of plan.targets) {
		const mine = [...outcomes.values()].flatMap((outcome) => [
			...outcome.blocked.filter((f) => f.target === directory),
			...outcome.skipped.filter((f) => f.target === directory && isUnsettled(f)),
		]);
		if (mine.length > 0) {
			result.withheld.push(
				`${directory}: ${mine.length} file(s) it takes were not delivered`,
			);
			continue;
		}
		// Asked before the rehearsal's shortcut below, so it refuses where the write would.
		const delivering = selected.filter((group) => taken.includes(group.name));
		const claims = unrecordedClaims(delivering, directory, path, deliveries[directory]);
		if (claims.length > 0) {
			result.withheld.push(`${directory}: ${claims.join('; ')}`);
			continue;
		}
		const pending = [...outcomes.values()].some((outcome) =>
			outcome.written.some((f) => f.target === directory),
		);
		// Only a rehearsal gets here without a tag, or with files still to deliver: it has not
		// written what the lock would hash, and off a tag it has no version to name. Either way the
		// honest report is that the lock would be rewritten.
		if (delivery === null || (dryRun && pending)) {
			result.written.push(directory);
			continue;
		}

		const groups: Lock['groups'] = {};
		const compared: Lock['groups'] = {};
		for (const name of carried) groups[name] = lock.groups[name] ?? null;
		const unfit: string[] = [];
		for (const group of delivering) {
			const state = groupState(group, path);
			const files: LockedFiles = {};
			for (const [installed, entry] of Object.entries(state)) {
				if (entry === null) unfit.push(`${installed} is not there`);
				else files[installed] = entry;
			}
			// A lock is not written over a hook git will not execute: it would record the defect
			// as the delivered state, and the target's own gate would then fail on a fresh lock.
			const mode = hookModeDefect(group, state);
			if (mode !== null) unfit.push(`${mode.path} ${mode.problem}`);
			groups[group.name] = files;
			compared[group.name] = files;
		}
		if (unfit.length > 0) {
			result.withheld.push(`${directory}: ${unfit.join('; ')}`);
			continue;
		}
		const settled: Lock = { ...delivery, groups };
		const content = serializeLock(settled);
		const file = join(path, LOCK_FILE);
		// Settled whether or not the lock has to change: a lock already holding exactly this is
		// confirmed, and the owner's record is brought to agree with it. That is what heals a run
		// that died between writing a lock and recording it.
		if (!dryRun) result.settled.set(directory, { ...delivery, groups: compared });
		// Only a lock that differs is rewritten, so a second run of the same write changes nothing.
		if (existsSync(file) && readFileSync(file, 'utf8').replaceAll('\r\n', '\n') === content) {
			continue;
		}
		if (!dryRun) writeFileSync(file, content);
		result.written.push(directory);
	}
	return result;
}
