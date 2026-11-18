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
 * nothing except say so. The write path landed per group, absorbing the license sync script it
 * replaced, install-leak-guard.ts and install-history-guard.ts one at a time, each kept working
 * as a thin delegate to this script. The ownership and safety contract is documented by the types
 * and assertions in `scripts/lib/shared-core/`.
 *
 * OWNER VERSUS RUNNER. This script is itself a shared file present in more than one repository, so
 * it cannot infer ownership from where it is running — that would make whichever repository you
 * happened to be standing in the source of truth. Every group names its owner, and the repository
 * is identified by its package name. In the owner, `--check` sweeps the fleet and `--write`
 * delivers. Anywhere else `--check` reads this repository and its own smokestack.lock and nothing
 * beside it (see lib/shared-core/self-check.ts), and there is no write.
 *
 *   bun scripts/sync-shared-core.ts --check [--group <name>] [--fleet-root <dir>]
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { dirname, resolve } from 'node:path';
import { argv, cwd, exit } from 'node:process';

import { checkGroup } from './lib/shared-core/check.ts';
import { noRecord } from './lib/shared-core/deliveries.ts';
import { departedOrNone } from './lib/shared-core/departed.ts';
import { frozenRefusal, loadOwnerFrozen } from './lib/shared-core/frozen.ts';
import { holdListedRows, localToday } from './lib/shared-core/known-drift.ts';
import { scopeFindings } from './lib/shared-core/lock-scope.ts';
import { loadManifest, type SharedCoreGroup } from './lib/shared-core/manifest.ts';
import { holdRecordLock, holdRecordLockUntilExit } from './lib/shared-core/record-lock.ts';
import { reportCheck, reportWrite } from './lib/shared-core/report.ts';
import {
	configRoot,
	defaultFleetRoot,
	describeRoots,
	loadFleetRoots,
} from './lib/shared-core/roots.ts';
import { forgetRunAnswers } from './lib/shared-core/run-cache.ts';
import { runSelfCheck } from './lib/shared-core/self-check.ts';
import { parseSharedCoreArgs, type SharedCoreOptions, USAGE } from './lib/shared-core/sync-args.ts';
import { runRecord, type RunRecord } from './lib/shared-core/worktree-record.ts';
import { repoIdentity } from './lib/shared-core/write.ts';

function selectGroups(groups: SharedCoreGroup[], names: string[]): SharedCoreGroup[] {
	if (names.length === 0) return groups;
	// Every unknown name at once, and an error rather than a silent empty run: a typo in one of
	// several --group flags would otherwise read as "that group had nothing to do".
	const unknown = names.filter((name) => !groups.some((g) => g.name === name));
	if (unknown.length > 0) throw new Error(`No manifest group named '${unknown.join("', '")}'.`);
	return groups.filter((g) => names.includes(g.name));
}

/**
 * Where a run happens. The command line runs here, from `cwd()` with the manifest beside this
 * file, and a write holds the record lock until the process exits. An in-process caller names a
 * repository and its manifest folder instead, and its write's lock goes in `releases`, which
 * `runSharedCoreCli` empties in a `finally` (test-suite-lanes-stage-two; Morticia #55075).
 */
export interface SyncPlace {
	manifestDir: string;
	releases?: (() => void)[];
	root: string;
}

const HERE: SyncPlace = { manifestDir: dirname(import.meta.path), root: resolve(cwd()) };

export function runSharedCoreSync(options: SharedCoreOptions, place: SyncPlace = HERE): number {
	if (options.help) {
		console.info(USAGE);
		return 0;
	}
	if (!options.check && !options.write) {
		console.info('Nothing to do: pass --check or --write.');
		console.info(USAGE);
		return 0;
	}

	// No earlier run's answers carry into this one (lib/shared-core/run-cache.ts).
	forgetRunAnswers();
	const root = resolve(place.root);
	// The manifest is delivered beside this file, so it is read from there, at whatever depth.
	const manifest = loadManifest(place.manifestDir);
	const identity = repoIdentity(root);
	if (!manifest.some((group) => group.owner === identity)) {
		return runAsConsumer(options, root, manifest);
	}

	// From here this checkout is the owner of every group (the loader admits one owner): the baseline
	// is this checkout wherever the targets live, and what a write delivers from.
	// The rosters and the deliveries record are gitignored, so from a branch worktree they are read
	// from the main checkout, and the fleet root defaults to that checkout's parent (lib/shared-core/
	// roots.ts). Saying which were used keeps a worktree run from passing on an empty roster unseen.
	const fleetRoot =
		options.fleetRoot === undefined ? defaultFleetRoot(root) : resolve(options.fleetRoot);
	const groups = selectGroups(manifest, options.groups);
	// The frozen list before any target is read, dry run included (lib/shared-core/frozen.ts),
	// through the same loader as the wrapper and the installers; this one holds for a write typed
	// by hand.
	if (options.write) {
		const refusal = frozenRefusal(loadOwnerFrozen(root), options.only);
		if (refusal !== null) {
			console.error(`[FAIL] ${refusal} Nothing was written.`);
			return 1;
		}
	}
	console.info(`Configuration: rosters and deliveries from ${configRoot(root)}.`);
	console.info(describeRoots(fleetRoot, loadFleetRoots(fleetRoot)));

	// The owner's record of deliveries (lib/shared-core/deliveries.ts), read under the record lock by a
	// write. Unreadable is exit 2; missing fails on its own account, after the comparison. A target
	// that is a linked worktree is read against its canonical checkout (lib/shared-core/worktree-
	// record.ts), and one whose canonical checkout has no record is refused, naming that root.
	let run: RunRecord;
	try {
		if (options.write && place.releases) place.releases.push(holdRecordLock(root));
		else if (options.write) holdRecordLockUntilExit(root);
		run = runRecord(root, fleetRoot);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		console.error(`[FAIL] The record of deliveries could not be read: ${reason}`);
		return 2;
	}
	for (const canonical of run.unrecorded)
		console.error(`${noRecord(canonical)} Nothing was written.`);
	if (run.unrecorded.length > 0 && !(options.write && options.dryRun)) return 1;
	const { deliveries } = run;
	const departed = departedOrNone(root, fleetRoot);
	const reports = groups.map((group) =>
		checkGroup(group, fleetRoot, root, options.only, deliveries, departed),
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
		// Rows already known (an end date) and repositories that keep their own gate (a decision),
		// from lib/shared-core/known-drift.ts. Untracked like the rosters, so a branch worktree reads
		// the main checkout's.
		const held = holdListedRows(configRoot(root), reports, scope, localToday());
		if (typeof held === 'string') {
			console.error(`[FAIL] ${held}`);
			return 2;
		}
		const code = reportCheck(
			held.reports,
			options.only,
			deliveries === null,
			fleetRoot,
			held.scope,
		);
		for (const line of held.lines) console.info(line);
		return code;
	}
	// The whole manifest, not the selection: a narrowed write has to know what else a target takes.
	const code = reportWrite(reports, manifest, fleetRoot, root, options, run);
	return run.unrecorded.length > 0 ? Math.max(code, 1) : code;
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

/**
 * The command line as a function: parse, run, and turn a throw into `[FAIL]` and exit 1, as the
 * script does. A mistyped flag must not fall through to a real fleet-wide write, which is the trap
 * the old license sync script laid, so bad arguments exit 2, distinct from drift's exit 1. Given a
 * place with a `releases` list, every record lock its run took is released before this returns,
 * on a throw too.
 */
export function runSharedCoreCli(args: string[], place: SyncPlace = HERE): number {
	const fail = (err: unknown): void => {
		console.error(`[FAIL] ${err instanceof Error ? err.message : String(err)}`);
	};
	let options: SharedCoreOptions;
	try {
		options = parseSharedCoreArgs(args);
	} catch (err) {
		fail(err);
		console.error(USAGE);
		return 2;
	}
	try {
		return runSharedCoreSync(options, place);
	} catch (err) {
		fail(err);
		return 1;
	} finally {
		for (const release of place.releases?.splice(0) ?? []) release();
	}
}

if (import.meta.main) exit(runSharedCoreCli(argv.slice(2)));
