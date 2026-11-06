/**
 * The part of a move that no manifest group describes: what smokestack keeps in a repository
 * without delivering it. move.ts moves the delivered files a lock records; these are not in any
 * group, so their old homes are named here.
 *
 *   - the lock, at the root before v0.6.0 (lock.ts PREVIOUS_LOCK_FILE). lock-write.ts writes the new
 *     one; this removes the old one once the new one is on disk;
 *   - the repository's `smokestack.json`, at the root before v0.6.0. It is the repository's own, so
 *     it is renamed into scripts/smokestack/, never rewritten;
 *   - core.hooksPath, which names the folder the delivered hooks were moved out of. It is a clone's
 *     setting, so it is set here for the fleet's checkout and by leak-guard-setup.sh in every other.
 *
 * Refused, as move.ts refuses, before anything is written: a lock or a config at both places (the
 * one at the new path is not one this write put there), and a hook that is the repository's own
 * (a foreign hook or a local chain the lock recorded at the old folder) still running a file this
 * write moves. Such a hook stays where it is, since the delivered hooks run it from there, and
 * would then fail every commit; the lead rewrites it first.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

import type { SharedCoreGroup } from './manifest.ts';
import type { Move } from './move.ts';

import { hooksPath, namesTargetRoot } from './dispatch.ts';
import { deliveredHooks, unchainedHooks } from './git-hooks.ts';
import { installedPath, isClaim, type Lock, LOCK_FILE, PREVIOUS_LOCK_FILE } from './lock.ts';

const RUNNER_GROUP = 'runner';
const PREVIOUS_CONFIG_FILE = 'smokestack.json';
const CONFIG_FILE = 'scripts/smokestack/smokestack.json';
const RUNNER_ENTRY = 'scripts/smokestack/smokestack.ts';

export interface HomeMove {
	directory: string;
	from: string;
	/** For a hooks path: every delivered hook that must be in the new folder before it is set. */
	hooks?: string[];
	/** A config is renamed, a lock removed once its replacement is written, a hooks path set. */
	kind: 'config' | 'hooks-path' | 'lock';
	to: string;
}

/**
 * Whether the runner this write delivers reads its config from scripts/smokestack/: it does exactly
 * when it is installed there (lib/smokestack/config.ts), so the config moves only then. A runner
 * installed anywhere else reads the config at the root, and moving it would leave the gate with none.
 */
function readsHomeConfig(groups: SharedCoreGroup[]): boolean {
	const runner = groups.find((group) => group.name === RUNNER_GROUP);
	return runner?.files.some((file) => installedPath(runner, file) === RUNNER_ENTRY) === true;
}

/** What one target needs beyond its delivered files' moves, and why it may not be made. */
export function planHome(
	root: string,
	directory: string,
	lock: Lock,
	moves: Move[],
	groups: SharedCoreGroup[],
): { home: HomeMove[]; refusals: string[] } {
	const home: HomeMove[] = [];
	const refusals: string[] = [];
	const at = (path: string): boolean => existsSync(join(root, path));
	const both = (from: string, to: string): string =>
		`${directory}: ${from} and ${to} both exist, so the one at ${to} is not one this write put ` +
		'there. Keep one of them by hand.';

	if (at(PREVIOUS_LOCK_FILE)) {
		if (at(LOCK_FILE)) refusals.push(both(PREVIOUS_LOCK_FILE, LOCK_FILE));
		else home.push({ directory, from: PREVIOUS_LOCK_FILE, kind: 'lock', to: LOCK_FILE });
	}
	if (RUNNER_GROUP in lock.groups && readsHomeConfig(groups) && at(PREVIOUS_CONFIG_FILE)) {
		if (at(CONFIG_FILE)) refusals.push(both(PREVIOUS_CONFIG_FILE, CONFIG_FILE));
		else home.push({ directory, from: PREVIOUS_CONFIG_FILE, kind: 'config', to: CONFIG_FILE });
	}

	// Only where git dispatches from the folder the hooks are leaving. Unset, or another tool's
	// folder, is dispatch that is not ours, and stays as it is.
	const byName = new Map(groups.map((group) => [group.name, group]));
	const configured = hooksPath(root);
	const hookMoves = moves.filter((move) => byName.get(move.group)?.hook !== undefined);
	const leaving = hookMoves.find((move) =>
		namesTargetRoot(root, configured, posix.dirname(move.from)),
	);
	const group = leaving === undefined ? undefined : byName.get(leaving.group);
	if (group !== undefined) {
		// Everything the hook groups install, moved or new (post-checkout arrives new in v0.6.0).
		const hooks = deliveredHooks(groups);
		const orphans = unchainedHooks(root, configured, hooks);
		if (orphans.length > 0) {
			refusals.push(
				`${directory}: ${configured} holds ${orphans.join(', ')}, which no delivered hook ` +
					`runs, so pointing core.hooksPath at ${group.targetRoot} would stop running ` +
					'them. Move or remove them by hand first.',
			);
		} else {
			home.push({
				directory,
				from: configured,
				hooks,
				kind: 'hooks-path',
				to: group.targetRoot,
			});
		}
	}
	refusals.push(...ownHooksRunningMoved(root, directory, lock, moves, groups));
	return { home, refusals };
}

/**
 * Each hook the lock records as the repository's own (a claim) at a path the manifest no longer
 * installs at, which still names a file this write moves away.
 */
function ownHooksRunningMoved(
	root: string,
	directory: string,
	lock: Lock,
	moves: Move[],
	groups: SharedCoreGroup[],
): string[] {
	const refusals: string[] = [];
	for (const group of groups) {
		const recorded = lock.groups[group.name];
		if (recorded === undefined || recorded === null) continue;
		const installed = new Set(group.files.map((file) => installedPath(group, file)));
		for (const [path, entry] of Object.entries(recorded)) {
			if (!isClaim(entry) || installed.has(path) || !existsSync(join(root, path))) continue;
			// A plain substring: naming a moved path in a comment is refused too, the safe side.
			const body = readFileSync(join(root, path), 'utf8');
			for (const move of moves.filter((m) => body.includes(m.from))) {
				refusals.push(
					`${directory}: ${path} is this repository's own (${entry.claim}) and runs ` +
						`${move.from}, which this write moves to ${move.to}. The delivered hook now ` +
						`runs ${path} itself; rewrite it by hand so it no longer runs ${move.from}.`,
				);
			}
		}
	}
	return refusals;
}

/** Applies the home moves of a plan with no refusals. One line per action, for the report. */
export function applyHome(home: HomeMove[], fleetRoot: string, dryRun: boolean): string[] {
	const lines: string[] = [];
	for (const move of home) {
		const root = join(fleetRoot, move.directory);
		if (move.kind === 'hooks-path') {
			lines.push(hooksPathLine(root, move, dryRun));
			continue;
		}
		// The old lock goes only once the new one is written; otherwise both stay.
		if (!dryRun && move.kind === 'lock' && !existsSync(join(root, move.to))) {
			lines.push(`KEPT ${move.directory}: ${move.from} (${move.to} was not written)`);
			continue;
		}
		const verb = move.kind === 'lock' ? 'REMOVED' : 'MOVED';
		lines.push(
			`${dryRun ? `WOULD ${verb}` : verb} ${move.directory}: ${move.from} (now ${move.to})`,
		);
		if (dryRun) continue;
		if (move.kind === 'lock') {
			rmSync(join(root, move.from));
		} else {
			mkdirSync(dirname(join(root, move.to)), { recursive: true });
			renameSync(join(root, move.from), join(root, move.to));
		}
	}
	return lines;
}

/** Points core.hooksPath at the new folder, once every delivered hook is in it. */
function hooksPathLine(root: string, move: HomeMove, dryRun: boolean): string {
	const what = `${move.directory}: core.hooksPath ${move.from} (now ${move.to})`;
	if (dryRun) return `WOULD SET ${what}`;
	// Pointed at a folder missing any delivered hook, git would silently skip that hook's guard.
	const missing = (move.hooks ?? [move.to]).filter((path) => !existsSync(join(root, path)));
	if (missing.length > 0) return `KEPT ${what}: ${missing.join(', ')} not written`;
	const set = Bun.spawnSync(['git', '-C', root, 'config', '--local', 'core.hooksPath', move.to], {
		stderr: 'pipe',
		stdout: 'pipe',
		windowsHide: true,
	});
	if (set.exitCode === 0) return `SET ${what}`;
	return `NOT SET ${what}: ${set.stderr.toString().trim()}`;
}
