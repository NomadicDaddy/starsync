/**
 * Moving a delivered file to a new installed path: the part of a write that a change of `target`
 * or `targetRoot` in the manifest needs beyond copying files.
 *
 * Nothing declares a move. A target's lock records, per group, where each file was installed; the
 * manifest says where it installs now. A recorded path the manifest no longer installs at, which
 * still ends with a file's `source`, is that file's old home. So the old manifest is never needed,
 * and a move is found the same way whatever renamed it.
 *
 * Everything here is planned before the first file is written, so a refusal leaves the target as
 * it was. The plan refuses:
 *   - an old copy whose bytes differ from what its lock recorded: a local edit would be lost;
 *   - a file already at a new path that the lock does not record, unless its bytes are exactly what
 *     this release delivers there (an earlier write copied it and then withheld the lock): any other
 *     file there is not smokestack's, so it is never overwritten or replaced;
 *   - a package.json script that names an old path more than once, or a package.json with
 *     uncommitted changes: the rewrite could not be made safely, so the lead makes it.
 *
 * Applied after the copies: a synced old file is removed (the write has put the new one in place),
 * a seeded one is renamed (its content is the repository's own), the folders a removal empties are
 * removed up to the target's scripts/, and each script naming an old path once is rewritten. A hook
 * the lock records as the repository's own is not moved: the delivered hooks run it where it is.
 * The lock, the config and core.hooksPath move with the files: move-home.ts.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { SharedCoreGroup } from './manifest.ts';

import {
	hashShared,
	installedPath,
	isClaim,
	type Lock,
	type LockedFiles,
	readLock,
} from './lock.ts';
import { applyHome, type HomeMove, planHome } from './move-home.ts';
import { applyScriptEdits, planScriptEdits, type ScriptEdit } from './move-scripts.ts';
import { readShared, resolveSource } from './owner.ts';
import { type Reference, referenceLines, referencesTo, unreadFiles } from './references.ts';
import { readScripts } from './targets.ts';

export interface Move {
	directory: string;
	from: string;
	group: string;
	seeded: boolean;
	/** The owner's file this release installs at `to`, in the variant this target is due. */
	source: string;
	to: string;
}

export interface MovePlan {
	home: HomeMove[];
	/** The consumer's own files naming a moved path, which its lead changes (references.ts). */
	leads: { directory: string; references: Reference[] }[];
	moves: Move[];
	refusals: string[];
	scripts: ScriptEdit[];
}

/** Leaves out every target in `held`: its lock was withheld, so it still names the old paths. */
export function holdBack(plan: MovePlan, held: Set<string>): void {
	plan.home = plan.home.filter((move) => !held.has(move.directory));
	plan.leads = plan.leads.filter((lead) => !held.has(lead.directory));
	plan.moves = plan.moves.filter((move) => !held.has(move.directory));
	plan.scripts = plan.scripts.filter((edit) => !held.has(edit.directory));
}

/**
 * The folder a group was installed under before, read from its lock: the prefix that, put before
 * each file's `source`, names the most recorded paths the manifest no longer installs at. One prefix
 * per group, so two files with the same name in different folders are never paired with each other's
 * old copy. Null when no recorded path is a file of this group at another place.
 */
function oldPrefix(
	group: SharedCoreGroup,
	recorded: string[],
	installed: Set<string>,
): null | string {
	const counts = new Map<string, number>();
	for (const file of group.files) {
		for (const path of recorded) {
			if (
				installed.has(path) ||
				!(path === file.source || path.endsWith(`/${file.source}`))
			) {
				continue;
			}
			const prefix = path.slice(0, path.length - file.source.length);
			counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
		}
	}
	let best: null | string = null;
	for (const [prefix, n] of counts)
		if (best === null || n > (counts.get(best) ?? 0)) best = prefix;
	return best;
}

/**
 * The old folder of `group` in a lock that records it at another place, or null when the lock records
 * it where the manifest installs it. The write moves from this folder; the sweep reports a target
 * still holding it as behind (lock-check.ts).
 */
export function layoutPrefix(group: SharedCoreGroup, recorded: LockedFiles): null | string {
	const installed = new Set(group.files.map((file) => installedPath(group, file)));
	return oldPrefix(group, Object.keys(recorded), installed);
}

/**
 * Each file the lock records at a path the manifest no longer installs it at, with its new path. A
 * seeded file is not in the lock, so it moves from the same old folder where a copy is present.
 */
function movesIn(
	root: string,
	directory: string,
	lock: Lock,
	groups: SharedCoreGroup[],
	ownerRoot: string,
): Move[] {
	const moves: Move[] = [];
	const scripts = readScripts(root);
	for (const group of groups) {
		const recorded = lock.groups[group.name];
		if (recorded === undefined || recorded === null) continue;
		const prefix = layoutPrefix(group, recorded);
		if (prefix === null) continue;
		for (const file of group.files) {
			const to = installedPath(group, file);
			const from = `${prefix}${file.source}`;
			if (from === to || to in recorded) continue;
			// A hook that is the repository's own stays put: the delivered hook runs it from there.
			const entry = recorded[from];
			if (entry !== undefined && isClaim(entry)) continue;
			const seeded = file.disposition === 'seeded';
			if (seeded ? existsSync(join(root, from)) : from in recorded) {
				const source = join(ownerRoot, group.sourceRoot, resolveSource(file, scripts));
				moves.push({ directory, from, group: group.name, seeded, source, to });
			}
		}
	}
	return moves;
}

/** Every move, script rewrite and refusal for the targets `directories` under `fleetRoot`. */
export function planMoves(
	directories: string[],
	groups: SharedCoreGroup[],
	fleetRoot: string,
	ownerRoot: string,
): MovePlan {
	const plan: MovePlan = { home: [], leads: [], moves: [], refusals: [], scripts: [] };
	for (const directory of directories) {
		const root = join(fleetRoot, directory);
		let lock: Lock | null;
		try {
			lock = readLock(root);
		} catch {
			continue; // An unreadable lock is planLocks' refusal to report, not this one's.
		}
		if (lock === null) continue;
		const moves = movesIn(root, directory, lock, groups, ownerRoot);
		const home = planHome(root, directory, lock, moves, groups);
		plan.home.push(...home.home);
		plan.refusals.push(...home.refusals);
		// The lock and the config move as files too; a hooks path is a setting, not a file.
		const moved = new Map([
			...moves.map((move): [string, string] => [move.from, move.to]),
			...home.home
				.filter((move) => move.kind !== 'hooks-path')
				.map((move): [string, string] => [move.from, move.to]),
		]);
		const references = referencesTo(root, moved);
		if (references.length > 0) plan.leads.push({ directory, references });
		if (moved.size > 0) {
			for (const unread of unreadFiles(root)) {
				plan.refusals.push(
					`${directory}: ${unread}; a file naming a moved path could go unseen.`,
				);
			}
		}
		if (moves.length === 0) continue;
		for (const move of moves) {
			const entry = lock.groups[move.group]?.[move.from];
			const from = join(root, move.from);
			if (entry !== undefined && !isClaim(entry) && existsSync(from)) {
				if (hashShared(from) !== entry.sha256) {
					plan.refusals.push(
						`${directory}: ${move.from} was edited after delivery, so moving it to ` +
							`${move.to} would lose that edit. Restore or move it by hand.`,
					);
				}
			}
			const at = join(root, move.to);
			if (existsSync(at) && readShared(at) !== readShared(move.source)) {
				plan.refusals.push(
					`${directory}: ${move.to} already exists and smokestack did not deliver it there.`,
				);
			}
		}
		const rewrites = planScriptEdits(root, directory, moves);
		plan.refusals.push(...rewrites.refusals);
		plan.moves.push(...moves);
		plan.scripts.push(...rewrites.edits);
	}
	return plan;
}

/** Removes the folders above `path` that are now empty, stopping at the target's scripts/. */
function pruneEmpty(root: string, path: string): void {
	let dir = dirname(path);
	while (dir.startsWith(root) && dir !== root && basename(dir) !== 'scripts') {
		if (readdirSync(dir).length > 0) return;
		rmdirSync(dir);
		dir = dirname(dir);
	}
}

/** Applies a plan with no refusals. Returns one line per action, for the write's report. */
export function applyMoves(plan: MovePlan, fleetRoot: string, dryRun: boolean): string[] {
	const lines: string[] = [];
	for (const move of plan.moves) {
		const root = join(fleetRoot, move.directory);
		const from = join(root, move.from);
		const verb = move.seeded ? 'MOVED' : 'REMOVED';
		// A synced old copy goes only once its replacement is on disk; otherwise both stay.
		if (!dryRun && !move.seeded && !existsSync(join(root, move.to))) {
			lines.push(`KEPT ${move.directory}: ${move.from} (${move.to} was not written)`);
			continue;
		}
		lines.push(
			`${dryRun ? `WOULD ${verb}` : verb} ${move.directory}: ${move.from} (now ${move.to})`,
		);
		if (dryRun || !existsSync(from)) continue;
		// A seeded file is the repository's own: its content replaces the fresh seed just written.
		if (move.seeded) {
			mkdirSync(dirname(join(root, move.to)), { recursive: true });
			renameSync(from, join(root, move.to));
		} else {
			rmSync(from);
		}
		pruneEmpty(root, from);
	}
	lines.push(...applyScriptEdits(plan.scripts, fleetRoot, dryRun));
	lines.push(...applyHome(plan.home, fleetRoot, dryRun));
	// Not changed by the write: listed so the lead changes each in the delivery commit.
	for (const lead of plan.leads) lines.push(...referenceLines(lead.directory, lead.references));
	return lines;
}
