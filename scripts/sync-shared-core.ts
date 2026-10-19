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
 * happened to be standing in the source of truth. Every group names its owner, and the repository
 * is identified by its package name. In the owner, `--check` sweeps the fleet and `--write`
 * delivers. Anywhere else `--check` reads this repository and its own smokestack.lock and nothing
 * beside it (see lib/shared-core/self-check.ts), and there is no write.
 *
 *   bun scripts/sync-shared-core.ts --check [--group <name>] [--fleet-root <dir>]
 */
import { dirname, resolve } from 'node:path';
import { argv, cwd, exit } from 'node:process';
import { parseArgs } from 'node:util';

import { checkGroup } from './lib/shared-core/check.ts';
import { type Deliveries, readDeliveries } from './lib/shared-core/deliveries.ts';
import { scopeFindings } from './lib/shared-core/lock-scope.ts';
import { loadManifest, type SharedCoreGroup } from './lib/shared-core/manifest.ts';
import { reportCheck, reportWrite } from './lib/shared-core/report.ts';
import { describeRoots, loadFleetRoots } from './lib/shared-core/roots.ts';
import { runSelfCheck } from './lib/shared-core/self-check.ts';
import { repoIdentity } from './lib/shared-core/write.ts';

const USAGE = `sync-shared-core — sync the files this fleet shares between peer repositories.

  --check                 In the owner: compare every group's targets against it and report. In
                          any other repository: check this repository against its own
                          smokestack.lock, and nothing else. Read-only. The flags below this one
                          belong to the owner and are refused elsewhere.
  --write                 Deliver and replace the files --check reports as absent or drifted, for
                          the groups this repository owns. Refuses to overwrite uncommitted work.
                          Made only from the annotated tag of this repository's version, with no
                          tracked file modified. Rewrites the smokestack.lock of each target that
                          has one, once every group that target takes is delivered.
  --dry-run               With --write: run every refusal and report what would be written. Off a
                          tag it warns and goes on.
  --group <name>          Restrict to one manifest group. Repeatable; a subsystem whose files span
                          more than one group is named one group per flag.
  --only <csv>            Restrict to the named target directories. Narrows what the group's target
                          model already resolved; it can never add a target the model rejected.
  --fleet-root <dir>      Directory holding the peer repositories. Defaults to the parent of this
                          repository. Its untracked .shared-core-roots.json names the other
                          repo-holding roots this does not sweep, each with its reason.
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

function selectGroups(groups: SharedCoreGroup[], names: string[]): SharedCoreGroup[] {
	if (names.length === 0) return groups;
	// Every unknown name at once, and an error rather than a silent empty run: a typo in one of
	// several --group flags would otherwise read as "that group had nothing to do".
	const unknown = names.filter((name) => !groups.some((g) => g.name === name));
	if (unknown.length > 0) throw new Error(`No manifest group named '${unknown.join("', '")}'.`);
	return groups.filter((g) => names.includes(g.name));
}

export function runSharedCoreSync(options: SharedCoreOptions): number {
	if (options.help) {
		console.info(USAGE);
		return 0;
	}
	if (!options.check && !options.write) {
		console.info('Nothing to do: pass --check or --write.');
		console.info(USAGE);
		return 0;
	}

	const root = resolve(cwd());
	// The manifest is delivered beside this file, so it is read from here, at whatever depth.
	const manifest = loadManifest(dirname(import.meta.path));
	const identity = repoIdentity(root);
	if (!manifest.some((group) => group.owner === identity)) {
		return runAsConsumer(options, root, manifest);
	}

	// From here this checkout is the owner, and the manifest loader admits one owner, so it is the
	// owner of every group: the baseline is this checkout wherever the targets live. A foreign
	// --fleet-root holds no copy of it, and the one on disk here is what a write delivers from.
	const fleetRoot = options.fleetRoot === undefined ? dirname(root) : resolve(options.fleetRoot);
	const groups = selectGroups(manifest, options.groups);
	console.info(describeRoots(fleetRoot, loadFleetRoots(fleetRoot)));

	// The owner's own record of what it delivered under this fleet root (lib/shared-core/
	// deliveries.ts). One that cannot be read is exit 2: nothing was learned. One that is not there
	// is a failure in its own right, reported after the comparison so its findings are still seen.
	let deliveries: Deliveries | null;
	try {
		deliveries = readDeliveries(root, fleetRoot);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		console.error(`[FAIL] The record of deliveries could not be read: ${reason}`);
		return 2;
	}
	const reports = groups.map((group) =>
		checkGroup(group, fleetRoot, root, options.only, deliveries ?? {}),
	);

	if (options.check) {
		const scope = scopeFindings(
			reports,
			manifest,
			deliveries ?? {},
			fleetRoot,
			root,
			options.only,
		);
		return reportCheck(reports, options.only, deliveries === null, fleetRoot, scope);
	}
	// The whole manifest, not the selection: a narrowed write has to know what else a target takes.
	return reportWrite(reports, manifest, fleetRoot, root, options.dryRun, deliveries);
}

/**
 * A repository that owns no group checks itself against its own lock and looks at nothing else.
 * Every flag that narrows or moves the owner's sweep is refused here rather than ignored: a flag
 * that silently does nothing reads as a check that was narrowed and passed.
 */
function runAsConsumer(
	options: SharedCoreOptions,
	root: string,
	manifest: SharedCoreGroup[],
): number {
	const refused = [
		...(options.write ? ['--write'] : []),
		...(options.groups.length > 0 ? ['--group'] : []),
		...(options.only === undefined ? [] : ['--only']),
		...(options.fleetRoot === undefined ? [] : ['--fleet-root']),
	];
	if (refused.length > 0) {
		console.error(
			`[FAIL] ${refused.join(', ')} cannot be used here: this repository owns no group, so ` +
				'it has no fleet to sweep and nothing to write. It checks itself against its own ' +
				'smokestack.lock with --check alone.',
		);
		return 2;
	}
	return runSelfCheck(root, manifest);
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
