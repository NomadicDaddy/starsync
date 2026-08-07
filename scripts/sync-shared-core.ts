#!/usr/bin/env bun
/**
 * sync-shared-core.ts — one mechanism for every file this fleet shares between peer repositories.
 *
 * Enforces: every file a manifest group declares is present and byte-identical in each target that
 * the group applies to. No assertion ID: the groups span repositories whose assertion catalogs
 * differ, and an ID from one of them would not resolve in the others.
 *
 * Today this is the READ-ONLY half. `--check` compares each manifest group's targets against its
 * owner and reports; there is no write path yet, and running with no arguments does nothing except
 * say so. The write path lands per group, absorbing sync-license-core.ts, install-leak-guard.ts and
 * install-history-guard.ts one at a time, each kept working as a thin delegate until its group has
 * been through one clean --check cycle. Design: common/gatesync.md, section 3a.
 *
 * OWNER VERSUS RUNNER. This script is itself a shared file present in more than one repository, so
 * it cannot infer ownership from where it is running — that would make whichever repository you
 * happened to be standing in the source of truth. Every group names its owner, and the write path
 * (when it exists) will push only the groups the running repository owns. `--check` is exempt and
 * verifies every group from anywhere, because reading cannot overwrite anything.
 *
 *   bun scripts/sync-shared-core.ts --check [--group <name>] [--fleet-root <dir>]
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { argv, cwd, exit } from 'node:process';

import { checkGroup, type Finding, type GroupReport, isFatal } from './lib/shared-core/check.ts';
import { loadManifest, type SharedCoreGroup } from './lib/shared-core/manifest.ts';
import { applyFindings, ownershipRefusal } from './lib/shared-core/write.ts';

const USAGE = `sync-shared-core — sync the files this fleet shares between peer repositories.

  --check                 Compare every group's targets against its owner and report. Read-only.
  --write                 Deliver and replace the files --check reports as absent or drifted, for
                          the groups this repository owns. Refuses to overwrite uncommitted work.
  --dry-run               With --write: run every refusal and report what would be written.
  --group <name>          Restrict to one manifest group. Repeatable; a subsystem whose files span
                          more than one group is named one group per flag.
  --only <csv>            Restrict to the named target directories. Narrows what the group's target
                          model already resolved; it can never add a target the model rejected.
  --fleet-root <dir>      Directory holding the peer repositories. Defaults to the parent of this
                          repository.
  --help                  This text.

--check and --write are exclusive. Neither is the default; with no mode this script does nothing.
`;

/**
 * Unknown flags are rejected rather than ignored.
 *
 * sync-license-core.ts, which this generalizes, tests only for the presence of --check. Every other
 * argument — including --help, and including a typo — falls through to the write path and performs
 * a real four-repository write. That is a trap laid for exactly the person trying to find out what
 * the script does, and it is not carried forward.
 */
interface Options {
	check: boolean;
	dryRun: boolean;
	fleetRoot?: string;
	groups: string[];
	help: boolean;
	only?: Set<string>;
	write: boolean;
}

function parseArgs(args: string[]): Options {
	const parsed: Options = {
		check: false,
		dryRun: false,
		groups: [],
		help: false,
		write: false,
	};
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] as string;
		if (arg === '--check') {
			parsed.check = true;
		} else if (arg === '--write') {
			parsed.write = true;
		} else if (arg === '--dry-run') {
			parsed.dryRun = true;
		} else if (arg === '--help' || arg === '-h') {
			parsed.help = true;
		} else if (arg === '--group' || arg === '--fleet-root' || arg === '--only') {
			const value = args[i + 1];
			if (value === undefined || value.startsWith('-')) {
				throw new Error(`${arg} needs a value.`);
			}
			if (arg === '--group') parsed.groups.push(value);
			else if (arg === '--only') {
				const names = value.split(',').map((s) => s.trim());
				parsed.only = new Set([...(parsed.only ?? []), ...names]);
			} else parsed.fleetRoot = value;
			i += 1;
		} else {
			throw new Error(`Unrecognized argument '${arg}'.\n\n${USAGE}`);
		}
	}
	// Exclusive rather than "write wins" or "check wins": both readings are defensible, which is
	// precisely why neither should be guessed on a command that overwrites files in other people's
	// repositories.
	if (parsed.check && parsed.write) {
		throw new Error('--check and --write are exclusive. Pick one.');
	}
	if (parsed.dryRun && !parsed.write) {
		throw new Error('--dry-run only means anything with --write.');
	}
	return parsed;
}

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

function printReport(report: GroupReport): void {
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

function selectGroups(scriptsDir: string, names: string[]): SharedCoreGroup[] {
	const groups = loadManifest(scriptsDir);
	if (names.length === 0) return groups;
	// Every unknown name at once, and an error rather than a silent empty run: a typo in one of
	// several --group flags would otherwise read as "that group had nothing to do".
	const unknown = names.filter((name) => !groups.some((g) => g.name === name));
	if (unknown.length > 0) throw new Error(`No manifest group named '${unknown.join("', '")}'.`);
	return groups.filter((g) => names.includes(g.name));
}

function reportCheck(reports: GroupReport[], unverifiable: string[]): void {
	for (const report of reports) printReport(report);

	const findings = reports.flatMap((r) => r.findings);
	const fatal = findings.filter(isFatal);
	const uncovered = findings.filter((f) => f.kind === 'uncovered');

	console.log('');
	if (unverifiable.length > 0) console.warn(`NOT VERIFIED: ${unverifiable.join('; ')}.`);
	if (uncovered.length > 0) {
		console.log(
			`${uncovered.length} file(s) absent in targets the write path has not reached yet. ` +
				'Absent is a rollout gap, not drift; it does not fail this check.',
		);
	}
	if (fatal.length > 0) {
		const diverged = fatal.filter((f) => f.kind === 'diverged-hook').length;
		console.error(
			`\nShared core has drifted: ${fatal.length} file(s) differ from their owner.\n` +
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
		exit(1);
	}
	console.log('Shared core: no drift.');
}

/**
 * Ownership is enforced per group rather than per run, so a `--write` from spernakit pushes the
 * license core and says plainly that it left the aidd-owned hook groups alone. Refusing the whole
 * command because the manifest also describes someone else's groups would make the common case an
 * error and teach people to reach for `--group` reflexively, which is the opposite of the habit
 * this wants.
 */
function reportWrite(
	reports: GroupReport[],
	groups: SharedCoreGroup[],
	fleetRoot: string,
	root: string,
	dryRun: boolean,
): void {
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
			`Refused to write ${blocked} file(s) with uncommitted changes in the target repository. ` +
				'Commit or discard them there, then run this again.',
		);
		exit(1);
	}
	console.log(dryRun ? `Dry run: ${wrote} file(s) would change.` : `Wrote ${wrote} file(s).`);
}

async function main(): Promise<void> {
	const parsed = parseArgs(argv.slice(2));
	if (parsed.help) {
		console.log(USAGE);
		return;
	}
	if (!parsed.check && !parsed.write) {
		console.log('Nothing to do: pass --check or --write.');
		console.log(USAGE);
		return;
	}

	const root = resolve(cwd());
	const scriptsDir = join(root, 'scripts');
	const fleetRoot = parsed.fleetRoot === undefined ? dirname(root) : resolve(parsed.fleetRoot);

	const groups = selectGroups(scriptsDir, parsed.groups);
	const reports: GroupReport[] = [];
	const unverifiable: string[] = [];

	for (const group of groups) {
		const ownerRoot = join(fleetRoot, group.owner);

		// An owner that is not checked out cannot be a baseline, and comparing against nothing
		// would report every target as drifted. Warn and skip, the same as an absent sibling: CI
		// checks out one repository, and this gate has to stay green there.
		if (!existsSync(ownerRoot)) {
			unverifiable.push(
				`${group.name} (owner ${group.owner} not checked out at ${ownerRoot})`,
			);
			continue;
		}
		reports.push(checkGroup(group, fleetRoot, ownerRoot, parsed.only));
	}

	if (parsed.check) {
		reportCheck(reports, unverifiable);
		return;
	}
	if (unverifiable.length > 0) console.warn(`NOT VERIFIED: ${unverifiable.join('; ')}.`);
	reportWrite(reports, groups, fleetRoot, root, parsed.dryRun);
}

await main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	exit(1);
});
