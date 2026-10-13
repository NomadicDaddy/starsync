/**
 * The reporting half of the shared-core sync — how a run of `--check` or `--write` reads.
 *
 * Split out of sync-shared-core.ts, which sat exactly on the 300-line cap: the next line of
 * behaviour anywhere in it would have failed the gate, and rendering is the part with no claim on
 * the entry point. Nothing here decides anything. `reportCheck` and `reportWrite` consume the
 * findings check.ts already classified and the outcomes write.ts already produced, and their only
 * contribution beyond printing is the exit code the shape of those findings implies.
 *
 * Both modes stay together rather than splitting one file per mode, because they render the same
 * `Finding` list in the same severity order and a second copy of that ordering is the drift this
 * subsystem exists to catch.
 */
import type { SharedCoreGroup } from './manifest.ts';

import { type Finding, type GroupReport, isFatal } from './check.ts';
import { deliveredBy, type Deliveries, DELIVERIES_FILE, writeDeliveries } from './deliveries.ts';
import { type Delivery, planLocks, tagStanding, writeLocks } from './lock-write.ts';
import { LOCK_FILE } from './lock.ts';
import { reportClean } from './vacuity.ts';
import { applyFindings, ownershipRefusal, type WriteOutcome } from './write.ts';

function order(findings: Finding[]): Finding[] {
	// Keys are alphabetical to satisfy the sort rule; the VALUES carry the reporting order, which is
	// severity: what fails the gate, then what needs a decision, then what the write path will fix.
	const rank: Record<Finding['kind'], number> = {
		'diverged-hook': 1,
		drift: 0,
		'foreign-hook': 2,
		'local-chain': 6,
		'lost-delivery': 1,
		'not-applicable': 8,
		'stale-lock': 2,
		uncovered: 5,
		unguarded: 3,
		'unmanaged-dispatch': 7,
		unwired: 4,
	};
	return [...findings].sort((a, b) => rank[a.kind] - rank[b.kind]);
}

export function printReport(report: GroupReport): void {
	const findings = order(report.findings);
	const drift = findings.filter(isFatal).length;
	console.log(
		`\n${report.group} (owner: ${report.owner}) — ${report.targets} target(s), ` +
			`${report.matched} file(s) current, ${drift} drifted.`,
	);
	for (const finding of findings) {
		const label = finding.kind === 'drift' ? 'DRIFT' : finding.kind.toUpperCase();
		console.log(`  ${label.padEnd(19)} ${finding.target}: ${finding.detail}`);
	}
	for (const skip of report.skipped) console.log(`  ${'SKIPPED'.padEnd(19)} ${skip}`);
}

/**
 * The sentence for an owner with no record of deliveries for the fleet root it is running against.
 * Unconditional: there is no "nothing was delivered yet" case, because the only evidence for one
 * would be the targets' locks, and a target can delete its lock.
 */
function noRecord(fleetRoot: string): string {
	return (
		`[FAIL] There is no record of deliveries for the fleet root ${fleetRoot} in ` +
		`${DELIVERIES_FILE}. A checkout starts without one, on purpose, and only the adopt ` +
		'command creates it, from the locks that verify against this repository: ' +
		'bun run deliveries:adopt (with --fleet-root <dir> for another root).'
	);
}

export function reportCheck(
	reports: GroupReport[],
	only: Set<string> | undefined,
	recordMissing: boolean,
	fleetRoot: string,
	scope: Finding[],
): number {
	for (const report of reports) printReport(report);
	// What belongs to no group's comparison (lock-scope.ts), in a section of its own: a finding
	// about a group that does not exist has no group report to sit under.
	if (scope.length > 0) {
		console.log(`\n${LOCK_FILE}, by repository — ${scope.length} finding(s) no group covers.`);
		for (const finding of order(scope)) {
			const label = finding.kind.toUpperCase().padEnd(19);
			console.log(`  ${label} ${finding.target}: ${finding.detail}`);
		}
	}

	const findings = [...reports.flatMap((r) => r.findings), ...scope];
	const fatal = findings.filter(isFatal);
	const uncovered = findings.filter((f) => f.kind === 'uncovered');

	console.log('');
	if (uncovered.length > 0) {
		console.log(
			`${uncovered.length} file(s) absent. Where the write path has not reached a target yet ` +
				'that is a rollout gap, not drift, and does not fail this check. An absent file ' +
				"that a target's lock records as delivered is listed as LOST-DELIVERY, and does.",
		);
	}
	if (fatal.length > 0) {
		const diverged = fatal.filter((f) => f.kind === 'diverged-hook').length;
		console.error(
			`\n[FAIL] Shared core has drifted: ${fatal.length} file(s) differ from their owner.\n` +
				'These repositories carry a stale copy while reporting as covered, which is the ' +
				'failure this gate exists to catch. Resync them from the owning repository.',
		);
		// Named separately because `--write` will not clear these and saying "resync" alone would
		// send someone to a command that reports them as not writable and leaves the gate red.
		if (diverged > 0) {
			console.error(
				`\n${diverged} of them are DIVERGED-HOOK, which --write deliberately will not touch: ` +
					'each one is either a stale copy of ours or a hand-written local chain, and only a ' +
					'person can tell which. Each finding names both ways out.',
			);
		}
		const lost = fatal.filter((f) => f.kind === 'lost-delivery').length;
		if (lost > 0) {
			console.error(
				`\n${lost} of them are LOST-DELIVERY: a file that target was delivered and no ` +
					'longer holds. The next write from a tagged version delivers it again, once its ' +
					'removal is committed or undone there. The same kind names a group, a lock or a ' +
					'whole repository the record of deliveries holds and the fleet no longer does; ' +
					'where that is meant, the finding names the command that says so.',
			);
		}
		// Named separately for the opposite reason: nothing in that target needs resyncing.
		const stale = fatal.filter((f) => f.kind === 'stale-lock').length;
		if (stale > 0) {
			console.error(
				`\n${stale} of them are STALE-LOCK: the files in that target are current and its ` +
					`${LOCK_FILE} does not record them, or the lock and the record of deliveries ` +
					'disagree about what was last delivered there. The next write from a tagged ' +
					'version rewrites the lock and the record together. Where the finding is a ' +
					'group the lock names that does not reach that repository, or a file of such a ' +
					'group held there, no write settles it: it is corrected in that repository.',
			);
		}
		if (recordMissing) console.error(`\n${noRecord(fleetRoot)}`);
		return 1;
	}
	if (recordMissing) {
		console.error(noRecord(fleetRoot));
		return 1;
	}
	return reportClean(reports, only);
}

/**
 * Ownership is enforced per group rather than per run, so a `--write` from spernakit pushes the
 * license core and says plainly that it left the aidd-owned hook groups alone. Refusing the whole
 * command because the manifest also describes someone else's groups would make the common case an
 * error and teach people to reach for `--group` reflexively, which is the opposite of the habit
 * this wants.
 */
export function reportWrite(
	reports: GroupReport[],
	manifest: SharedCoreGroup[],
	fleetRoot: string,
	root: string,
	dryRun: boolean,
	deliveries: Deliveries | null,
): number {
	// Before anything else, a rehearsal included: a write updates the record, and never creates it.
	if (deliveries === null) {
		console.error(`${noRecord(fleetRoot)} Nothing was written.`);
		return 1;
	}
	const byName = new Map(manifest.map((g) => [g.name, g]));
	const verb = dryRun ? 'would write' : 'wrote';
	const owned = reports.filter((report) => {
		const refusal = ownershipRefusal(byName.get(report.group) as SharedCoreGroup, root);
		if (refusal !== null) console.log(`\n${report.group} — not ours to write: ${refusal}.`);
		return refusal === null;
	});
	const groups = owned.map((report) => byName.get(report.group) as SharedCoreGroup);

	// Both refusals below come before the first file, so a refused write has written nothing.
	let delivery: Delivery | null = null;
	if (owned.length > 0) {
		const standing = tagStanding(root);
		if ('delivery' in standing) delivery = standing.delivery;
		else if (dryRun) {
			console.warn(`[WARN] A write from here would be refused: ${standing.refusal}.`);
		} else {
			console.error(
				`[FAIL] A write is made only from a tagged version, and ${standing.refusal}. ` +
					'Nothing was written.',
			);
			return 1;
		}
	}
	const plan = planLocks(owned, groups, manifest, fleetRoot, root, delivery);
	if (plan.refusals.length > 0) {
		for (const refusal of plan.refusals) console.error(`- ${refusal}`);
		console.error(
			`[FAIL] ${plan.refusals.length} target(s) would be left with a ${LOCK_FILE} that does ` +
				'not describe them. Nothing was written.',
		);
		return 1;
	}

	const outcomes = new Map<string, WriteOutcome>();
	for (const report of owned) {
		const outcome = applyFindings(report.findings, fleetRoot, dryRun);
		outcomes.set(report.group, outcome);
		// A stale lock is not the file writer's to settle and is not left alone either: the lock
		// is rewritten below, and reported there. Nor is a lost delivery: the same absent file is
		// also an `uncovered` finding, which is the one the writer acts on.
		const skipped = outcome.skipped.filter(
			(f) => f.kind !== 'stale-lock' && f.kind !== 'lost-delivery',
		);

		console.log(
			`\n${report.group} (owner: ${report.owner}) — ${verb} ${outcome.written.length} ` +
				`file(s), ${outcome.blocked.length} refused, ${skipped.length} not writable.`,
		);
		for (const f of outcome.written)
			console.log(`  ${verb.toUpperCase()} ${f.target}: ${f.detail}`);
		for (const f of outcome.blocked) console.log(`  REFUSED     ${f.target}: ${f.detail}`);
		for (const f of skipped) console.log(`  LEFT ALONE  ${f.target}: ${f.kind} — ${f.detail}`);
	}

	const locks = writeLocks(plan, outcomes, groups, delivery, dryRun, deliveries ?? {});
	if (plan.targets.length > 0) console.log(`\n${LOCK_FILE}`);
	for (const directory of locks.written) console.log(`  ${verb.toUpperCase()} ${directory}`);
	for (const reason of locks.withheld) console.log(`  WITHHELD    ${reason}`);
	// The record follows the locks this run settled, and no others: a lock withheld keeps the
	// entry of its last good delivery, and a target outside an --only narrowing is not touched.
	//
	// Only the groups this run delivered and compared are recorded from it. A group the run was
	// narrowed away from keeps the entry the record already has: copying it out of the target's
	// lock would write the target's own word into the owner's memory, which is how a hand-made
	// claim was once recorded by a write narrowed to some other group. Where such a kept entry
	// belongs to another version than this delivery, nothing is recorded for that target at all,
	// since one entry cannot name two versions; the unnarrowed write records it.
	if (!dryRun && locks.settled.size > 0) {
		const section = { ...deliveries };
		for (const [directory, lock] of locks.settled) {
			const entry = deliveredBy(lock);
			if (entry === null) continue;
			const before = section[directory];
			const kept = Object.keys(before?.groups ?? {}).some((name) => !(name in entry.groups));
			if (kept && (before?.version !== entry.version || before.commit !== entry.commit)) {
				continue;
			}
			section[directory] = { ...entry, groups: { ...before?.groups, ...entry.groups } };
		}
		if (writeDeliveries(root, fleetRoot, section)) {
			console.log(`\n${DELIVERIES_FILE}: recorded ${[...locks.settled.keys()].join(', ')}`);
		}
	}

	const wrote = [...outcomes.values()].reduce((sum, o) => sum + o.written.length, 0);
	const blocked = [...outcomes.values()].reduce((sum, o) => sum + o.blocked.length, 0);
	console.log('');
	if (blocked > 0) {
		console.error(
			`[FAIL] Refused to write ${blocked} file(s) with uncommitted changes in the target ` +
				'repository. Commit or discard them there, then run this again.',
		);
	}
	if (locks.withheld.length > 0) {
		console.error(
			`[FAIL] ${locks.withheld.length} ${LOCK_FILE} file(s) were not rewritten, so each still ` +
				'describes the delivery before this one. Settle what is named above and run again.',
		);
	}
	if (blocked > 0 || locks.withheld.length > 0) return 1;
	console.log(
		dryRun
			? `[OK] Dry run: ${wrote} file(s) and ${locks.written.length} lock(s) would change.`
			: `[OK] Wrote ${wrote} file(s) and ${locks.written.length} lock(s).`,
	);
	return 0;
}
