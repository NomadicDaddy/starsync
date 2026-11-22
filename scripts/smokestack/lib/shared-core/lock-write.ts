/**
 * The two things a write owes a lock: a tagged version to name (tag.ts), and the lock itself.
 *
 * A TAG: a write is made only from the owner's annotated tag, with no tracked file modified or
 * staged and every source file the manifest names tracked, and the bytes themselves are read from
 * the tag commit rather than the working tree, so the bytes delivered are the bytes that commit
 * holds even when a source differs from its blob without git reporting it modified. A source that
 * exists on disk but was never committed would otherwise be delivered from the working tree and its
 * lock read as forged against the tag; it is refused instead. Other untracked files do not block
 * it: nothing delivers them. The tag is cut before the write and before any
 * target's gate has run on those bytes, so it marks a delivery, not a verified one.
 *
 * THE LOCK, rewritten whole, at one version, at LOCK_FILE, for each target lock-plan.ts planned,
 * once every group the target takes has been delivered there with nothing refused.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Deliveries } from './deliveries.ts';
import type { LockPlan } from './lock-plan.ts';
import type { SharedCoreGroup } from './manifest.ts';
import type { Delivery } from './tag.ts';
import type { WriteOutcome } from './write.ts';

import { unrecordedClaims } from './delivery-check.ts';
import { groupState, hookModeDefects } from './expected.ts';
import { isUnsettled } from './lock-check.ts';
import { type Lock, LOCK_FILE, type LockedFiles, serializeLock } from './lock.ts';

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
			for (const mode of hookModeDefects(group, state))
				unfit.push(`${mode.path} ${mode.problem}`);
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
