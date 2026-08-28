#!/usr/bin/env bun
/**
 * sync-shared-core.ts — one mechanism for every file this fleet shares between peer repositories.
 *
 * Enforces: every file a manifest group declares is present and byte-identical in each target that
 * the group applies to. No assertion ID: the groups span repositories whose assertion catalogs
 * differ, and an ID from one of them would not resolve in the others.
 *
 * `--check` compares each manifest group's targets against its owner and reports; `--write` delivers
 * what `--check` found absent or drifted. Neither is the default: running with no arguments does
 * nothing except say so. The write path landed per group, absorbing sync-license-core.ts,
 * install-leak-guard.ts and install-history-guard.ts one at a time, each kept working as a thin
 * delegate to this script. The ownership and safety contract is documented by the types and
 * assertions in `scripts/lib/shared-core/`.
 *
 * OWNER VERSUS RUNNER. This script is itself a shared file present in more than one repository, so
 * it cannot infer ownership from where it is running — that would make whichever repository you
 * happened to be standing in the source of truth. Every group names its owner, and the write path
 * pushes only the groups the running repository owns. `--check` is exempt and verifies every group
 * from anywhere, because reading cannot overwrite anything.
 *
 *   bun scripts/sync-shared-core.ts --check [--group <name>] [--fleet-root <dir>]
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { argv, cwd, exit } from 'node:process';
import { parseArgs } from 'node:util';

import { checkGroup, type GroupReport } from './lib/shared-core/check.ts';
import { loadManifest, type SharedCoreGroup } from './lib/shared-core/manifest.ts';
import { reportCheck, reportWrite } from './lib/shared-core/report.ts';

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
 * Unknown flags are rejected rather than ignored. sync-license-core.ts, which this generalizes,
 * tests only for the presence of --check: every other argument — including --help, and including a
 * typo — falls through to the write path and performs a real four-repository write. That is a trap
 * laid for exactly the person trying to find out what the script does, and it is not carried here.
 */
export interface SharedCoreOptions {
	check: boolean;
	dryRun: boolean;
	fleetRoot?: string;
	groups: string[];
	help: boolean;
	only?: Set<string>;
	write: boolean;
}

export function parseSharedCoreArgs(args: string[]): SharedCoreOptions {
	const { values } = parseArgs({
		args,
		options: {
			check: { type: 'boolean' },
			'dry-run': { type: 'boolean' },
			'fleet-root': { type: 'string' },
			group: { multiple: true, type: 'string' },
			help: { short: 'h', type: 'boolean' },
			only: { multiple: true, type: 'string' },
			write: { type: 'boolean' },
		},
		strict: true,
	});
	// parseArgs takes the token after a value-taking flag as its value even when that token is
	// itself a flag, so `--group --check` would name a group nothing matches and quietly run zero
	// groups against a fleet the caller believed it had just checked.
	for (const [name, value] of Object.entries(values)) {
		const given = Array.isArray(value) ? value : [value];
		if (given.some((v) => typeof v === 'string' && (v.trim() === '' || v.startsWith('-')))) {
			throw new Error(`--${name} needs a value.`);
		}
	}
	const parsed: SharedCoreOptions = {
		check: values.check === true,
		dryRun: values['dry-run'] === true,
		groups: values.group ?? [],
		help: values.help === true,
		write: values.write === true,
	};
	if (values['fleet-root'] !== undefined) parsed.fleetRoot = values['fleet-root'];
	if (values.only !== undefined) {
		parsed.only = new Set(values.only.flatMap((v) => v.split(',').map((s) => s.trim())));
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

function selectGroups(scriptsDir: string, names: string[]): SharedCoreGroup[] {
	const groups = loadManifest(scriptsDir);
	if (names.length === 0) return groups;
	// Every unknown name at once, and an error rather than a silent empty run: a typo in one of
	// several --group flags would otherwise read as "that group had nothing to do".
	const unknown = names.filter((name) => !groups.some((g) => g.name === name));
	if (unknown.length > 0) throw new Error(`No manifest group named '${unknown.join("', '")}'.`);
	return groups.filter((g) => names.includes(g.name));
}

export function runSharedCoreSync(options: SharedCoreOptions): number {
	if (options.help) {
		console.log(USAGE);
		return 0;
	}
	if (!options.check && !options.write) {
		console.log('Nothing to do: pass --check or --write.');
		console.log(USAGE);
		return 0;
	}

	const root = resolve(cwd());
	const scriptsDir = join(root, 'scripts');
	const fleetRoot = options.fleetRoot === undefined ? dirname(root) : resolve(options.fleetRoot);

	const groups = selectGroups(scriptsDir, options.groups);
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
		reports.push(checkGroup(group, fleetRoot, ownerRoot, options.only));
	}

	if (options.check) return reportCheck(reports, unverifiable, options.only);
	if (unverifiable.length > 0) console.warn(`[WARN] NOT VERIFIED: ${unverifiable.join('; ')}.`);
	return reportWrite(reports, groups, fleetRoot, root, options.dryRun);
}

if (import.meta.main) {
	// A mistyped flag must not fall through to a real fleet-wide write, which is the trap
	// sync-license-core.ts lays. Bad arguments exit 2, distinct from drift's exit 1.
	let options: SharedCoreOptions;
	try {
		options = parseSharedCoreArgs(argv.slice(2));
	} catch (err) {
		console.error(`[FAIL] ${err instanceof Error ? err.message : String(err)}`);
		console.error(USAGE);
		exit(2);
	}
	try {
		exit(runSharedCoreSync(options));
	} catch (err) {
		console.error(`[FAIL] ${err instanceof Error ? err.message : String(err)}`);
		exit(1);
	}
}
