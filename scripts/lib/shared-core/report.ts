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
import { reportClean } from './vacuity.ts';
import { applyFindings, ownershipRefusal } from './write.ts';

function order(findings: Finding[]): Finding[] {
	// Keys are alphabetical to satisfy the sort rule; the VALUES carry the reporting order, which is
	// severity: what fails the gate, then what needs a decision, then what the write path will fix.
	const rank: Record<Finding['kind'], number> = {
		'diverged-hook': 1,
		drift: 0,
		'foreign-hook': 2,
		'local-chain': 5,
		'not-applicable': 7,
		uncovered: 4,
		'unmanaged-dispatch': 6,
		unwired: 3,
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

export function reportCheck(
	reports: GroupReport[],
	unverifiable: string[],
	only?: Set<string>,
): number {
	for (const report of reports) printReport(report);

	const findings = reports.flatMap((r) => r.findings);
	const fatal = findings.filter(isFatal);
	const uncovered = findings.filter((f) => f.kind === 'uncovered');

	console.log('');
	if (unverifiable.length > 0) console.warn(`[WARN] NOT VERIFIED: ${unverifiable.join('; ')}.`);
	if (uncovered.length > 0) {
		console.log(
			`${uncovered.length} file(s) absent in targets the write path has not reached yet. ` +
				'Absent is a rollout gap, not drift; it does not fail this check.',
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
	groups: SharedCoreGroup[],
	fleetRoot: string,
	root: string,
	dryRun: boolean,
): number {
	const byName = new Map(groups.map((g) => [g.name, g]));
	const verb = dryRun ? 'would write' : 'wrote';
	let wrote = 0;
	let blocked = 0;

	for (const report of reports) {
		const group = byName.get(report.group) as SharedCoreGroup;
		const refusal = ownershipRefusal(group, root);
		if (refusal !== null) {
			console.log(`\n${report.group} — not ours to write: ${refusal}.`);
			continue;
		}
		const outcome = applyFindings(report.findings, fleetRoot, dryRun);
		wrote += outcome.written.length;
		blocked += outcome.blocked.length;

		console.log(
			`\n${report.group} (owner: ${group.owner}) — ${verb} ${outcome.written.length} file(s), ` +
				`${outcome.blocked.length} refused, ${outcome.skipped.length} not writable.`,
		);
		for (const f of outcome.written)
			console.log(`  ${verb.toUpperCase()} ${f.target}: ${f.detail}`);
		for (const f of outcome.blocked) console.log(`  REFUSED     ${f.target}: ${f.detail}`);
		for (const f of outcome.skipped) {
			console.log(`  LEFT ALONE  ${f.target}: ${f.kind} — ${f.detail}`);
		}
	}

	console.log('');
	if (blocked > 0) {
		console.error(
			`[FAIL] Refused to write ${blocked} file(s) with uncommitted changes in the target ` +
				'repository. Commit or discard them there, then run this again.',
		);
		return 1;
	}
	console.log(
		dryRun ? `[OK] Dry run: ${wrote} file(s) would change.` : `[OK] Wrote ${wrote} file(s).`,
	);
	return 0;
}
