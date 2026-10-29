/**
 * The owner's sweep held to its own record of deliveries, not to what a lock says about itself.
 *
 * For every repository the record names, what the last write left there has to be there still: the
 * repository, reached by each recorded group; its lock, naming the recorded version and commit and
 * still recording each recorded group; every recorded file; and the hook claimed as the write
 * recorded it and no other way. Anything recorded that is gone is `lost-delivery`. A lock that
 * disagrees with the record, or records a delivery the record does not know, is `stale-lock`.
 *
 * A DEPARTURE IS ACKNOWLEDGED, NEVER INFERRED. A repository that leaves, or leaves a group, looks
 * exactly like one whose guard was deleted, so nothing here guesses which. The finding stays until
 * a write delivers again or a person says the departure is meant, with the forget command each
 * finding names.
 *
 * A RUN NARROWED WITH --only judges only the repositories it names: a recorded repository outside
 * the selection is not looked at, and a narrowed write does not touch its record. The unnarrowed
 * sweep is therefore the only place the record is enforced in full.
 *
 * The inference lock-check.ts makes from the lock and the owner's history is left in place beside
 * this. Where both see the same lost file it is reported once.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Finding, FindingKind } from './check.ts';
import type { SharedCoreGroup } from './manifest.ts';
import type { Target } from './targets.ts';

import { claimIn, type DeliveredTarget, type Deliveries } from './deliveries.ts';
import { groupState } from './expected.ts';
import { isClaim, type Lock, LOCK_FILE } from './lock.ts';

/** What a finding tells a person to run when the departure it reports is meant. */
function forget(target: string, group: string): string {
	return `If that is meant, say so: bun run deliveries:forget ${target} --group ${group}`;
}

const ADOPT = 'If it was made from here, take it into the record: bun run deliveries:adopt';

/**
 * Why a write may not record the claim a group's hook makes now, or null when it may.
 *
 * A hook that becomes a hand-kept chain, or another tool's, stops being compared with the owner's:
 * that is what the claim means. So a write has nothing of its own to say about such a hook, and if
 * it simply recorded the new claim it would settle, unasked, exactly the thing the sweep had been
 * reporting: mark a hook as a local chain, gut it, write the claim in the lock by hand, and the
 * next ordinary write made the record agree and both checks went green over a hook that does
 * nothing. A claim the record does not already hold is therefore a departure, and a departure is
 * acknowledged, never inferred: the write withholds that repository's lock and record until the
 * group is forgotten there on purpose, after which the claim is recorded as a first delivery's is.
 *
 * The hook is read from the repository at `path` as it stands, before anything else is decided,
 * so a rehearsal refuses exactly where the write would. `entry` is what the record holds for the
 * repository. Nothing is recorded yet for a first delivery, and a hook that has become the owner's
 * again is one the write has compared, so neither is refused.
 */
function unrecordedClaim(
	group: SharedCoreGroup,
	directory: string,
	path: string,
	entry: DeliveredTarget | undefined,
): null | string {
	const recorded = entry?.groups[group.name];
	if (recorded === undefined) return null;
	const held = Object.values(groupState(group, path)).find(
		(file) => file !== null && isClaim(file),
	);
	const now = held !== null && held !== undefined && isClaim(held) ? held.claim : undefined;
	if (now === undefined || now === recorded.claim) return null;
	const was = recorded.claim === undefined ? "the owner's" : `a ${recorded.claim}`;
	return (
		`the hook of '${group.name}' was recorded as ${was} and now claims to be a ${now}, which ` +
		`no write decides. ${forget(directory, group.name)}, then write again`
	);
}

/** Every such refusal among the groups a run is about to deliver to one repository. */
export function unrecordedClaims(
	groups: SharedCoreGroup[],
	directory: string,
	path: string,
	entry: DeliveredTarget | undefined,
): string[] {
	return groups.flatMap((group) => {
		const refusal = unrecordedClaim(group, directory, path, entry);
		return refusal === null ? [] : [refusal];
	});
}

export interface Held {
	findings: Finding[];
	/** Recorded paths of the group that the target no longer holds. Reported by the caller. */
	lost: string[];
}

/**
 * One group in one reached target, against the record. `lock` is null where the target has none.
 * `entry` is what the record holds for the target, or undefined where it holds nothing.
 */
export function heldToRecord(
	group: SharedCoreGroup,
	target: Target,
	lock: Lock | null,
	entry: DeliveredTarget | undefined,
): Held {
	const held: Held = { findings: [], lost: [] };
	const add = (kind: FindingKind, detail: string): void => {
		held.findings.push({ detail, group: group.name, kind, target: target.directory });
	};

	if (entry === undefined) {
		// The other direction: a delivery the owner has no memory of making. The lock may be
		// genuine, and then the record is what is wrong, which is no less a failure.
		if (lock?.version !== undefined) {
			add(
				'stale-lock',
				`${LOCK_FILE} records a delivery at v${lock.version} and the record of deliveries ` +
					`holds none for this repository. ${ADOPT}`,
			);
		}
		return held;
	}
	const recorded = entry.groups[group.name];
	if (recorded === undefined) {
		// The same other direction, for one group: the repository is in the record and this group
		// of it is not, as after the group was forgotten there, while its lock still records a
		// delivery of it. Until a write records the group again the record has no say over it, so
		// the sweep says so and stays red, as it does for a whole repository the record lost.
		const inLock = lock?.groups[group.name];
		if (lock?.version !== undefined && inLock !== undefined && inLock !== null) {
			add(
				'stale-lock',
				`${LOCK_FILE} records a delivery of this group at v${lock.version} and the record ` +
					'of deliveries holds none for it here. The next write from a tagged version ' +
					'records it.',
			);
		}
		return held;
	}
	const was = `v${entry.version} was delivered here`;
	held.lost = recorded.paths.filter((path) => !existsSync(join(target.path, path)));

	if (lock === null) {
		add(
			'lost-delivery',
			`${LOCK_FILE} is gone: ${was}. ${forget(target.directory, group.name)}`,
		);
		return held;
	}
	if (
		lock.version !== undefined &&
		(lock.version !== entry.version || lock.commit !== entry.commit)
	) {
		add(
			'stale-lock',
			`${LOCK_FILE} names v${lock.version} at ${lock.commit?.slice(0, 12)}, and the last ` +
				`delivery recorded here is v${entry.version} at ${entry.commit.slice(0, 12)}. ` +
				'The next write from a tagged version settles it.',
		);
	}
	const inLock = lock.groups[group.name];
	if (inLock === undefined || inLock === null) {
		// With files also gone, each lost file already says this; said here only when none is.
		if (held.lost.length === 0) {
			const now = inLock === null ? 'only declares the group' : 'no longer names the group';
			add(
				'lost-delivery',
				`${was} with ${recorded.paths.length} file(s) of this group, and ${LOCK_FILE} ` +
					`${now}. ${forget(target.directory, group.name)}`,
			);
		}
		return held;
	}
	const claim = claimIn(inLock);
	if (claim !== recorded.claim) {
		const says = (value: string | undefined): string =>
			value === undefined ? "the owner's hook" : `a ${value} claim`;
		// A hook that is the owner's again is one the next write compares, and so settles. A hook
		// that has become a claim is not: the write withholds it (unrecordedClaim) until a person
		// accepts it.
		const way =
			claim === undefined
				? 'The next write settles it.'
				: `No write accepts a claim it did not record. ${forget(target.directory, group.name)}, then write again.`;
		add(
			'stale-lock',
			`${LOCK_FILE} holds ${says(claim)} for this group's hook, and the last write recorded ` +
				`${says(recorded.claim)}. ${way}`,
		);
	}
	return held;
}

/**
 * The recorded repositories this group did not reach on this run: gone, renamed, moved, or no
 * longer taking the group. `reached` is the group's report so far, and `skipReasons` the reason
 * for each skipped directory, keyed exactly: matching a formatted "<directory> (" prefix let a
 * sibling named "<directory> (old)" lend its reason to the wrong repository.
 */
export function departedFindings(
	group: SharedCoreGroup,
	deliveries: Deliveries,
	fleetRoot: string,
	reached: string[],
	skipReasons: Map<string, string>,
	only?: Set<string>,
): Finding[] {
	const findings: Finding[] = [];
	for (const [directory, entry] of Object.entries(deliveries)) {
		if (entry.groups[group.name] === undefined || reached.includes(directory)) continue;
		if (only !== undefined && !only.has(directory)) continue;

		const skip = skipReasons.get(directory);
		let now = 'this group no longer reaches it';
		if (!existsSync(join(fleetRoot, directory))) {
			now = 'no repository is at that directory now (removed, renamed or moved)';
		} else if (skip !== undefined) {
			now = `it is now skipped: (${skip})`;
		}
		findings.push({
			detail: `v${entry.version} was delivered here, and ${now}. ${forget(directory, group.name)}`,
			group: group.name,
			kind: 'lost-delivery',
			target: directory,
		});
	}
	return findings;
}
