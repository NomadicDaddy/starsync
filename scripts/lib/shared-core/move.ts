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
 * removed up to the target's scripts/, and each script naming an old path once is rewritten.
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
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
import { readShared, resolveSource } from './owner.ts';
import { readScripts } from './targets.ts';
import { hasUncommittedChanges } from './write.ts';

export interface Move {
	directory: string;
	from: string;
	group: string;
	seeded: boolean;
	/** The owner's file this release installs at `to`, in the variant this target is due. */
	source: string;
	to: string;
}

export interface ScriptEdit {
	directory: string;
	from: string;
	script: string;
	to: string;
}

export interface MovePlan {
	moves: Move[];
	refusals: string[];
	scripts: ScriptEdit[];
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
			const seeded = file.disposition === 'seeded';
			if (seeded ? existsSync(join(root, from)) : from in recorded) {
				const source = join(ownerRoot, group.sourceRoot, resolveSource(file, scripts));
				moves.push({ directory, from, group: group.name, seeded, source, to });
			}
		}
	}
	return moves;
}

function escapePattern(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `path` as a whole path in a script, written bare or as `./path` (the fleet runs
 * `bun ./scripts/run-bash.ts`), and not inside a longer name such as `a.tsx` or `lib/a.ts`. The
 * `./`, when present, is the first group, so a rewrite keeps it.
 */
export function pathPattern(path: string): RegExp {
	return new RegExp(`(?<![\\w./-])(\\./)?${escapePattern(path)}(?![\\w.-])`, 'g');
}

/** Every move, script rewrite and refusal for the targets `directories` under `fleetRoot`. */
export function planMoves(
	directories: string[],
	groups: SharedCoreGroup[],
	fleetRoot: string,
	ownerRoot: string,
): MovePlan {
	const plan: MovePlan = { moves: [], refusals: [], scripts: [] };
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
		const scripts = readScripts(root) ?? {};
		const edits: ScriptEdit[] = [];
		for (const [script, value] of Object.entries(scripts)) {
			for (const move of moves) {
				const times = value.match(pathPattern(move.from))?.length ?? 0;
				if (times === 1) edits.push({ directory, from: move.from, script, to: move.to });
				else if (times > 1) {
					plan.refusals.push(
						`${directory}: package.json script ${script} names ${move.from} ${times} times; ` +
							'rewrite it by hand to the new path.',
					);
				}
			}
		}
		if (edits.length > 0) {
			let dirty: boolean;
			try {
				dirty = hasUncommittedChanges(root, 'package.json');
			} catch (err) {
				plan.refusals.push(
					`${directory}: ${err instanceof Error ? err.message : String(err)}`,
				);
				dirty = false;
			}
			if (dirty) {
				plan.refusals.push(
					`${directory}: package.json has uncommitted changes, so its scripts cannot be ` +
						'rewritten to the new paths.',
				);
			}
		}
		plan.moves.push(...moves);
		plan.scripts.push(...edits);
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
	const byTarget = new Map<string, ScriptEdit[]>();
	for (const edit of plan.scripts) {
		byTarget.set(edit.directory, [...(byTarget.get(edit.directory) ?? []), edit]);
	}
	for (const [directory, edits] of byTarget) {
		const path = join(fleetRoot, directory, 'package.json');
		let text = readFileSync(path, 'utf8');
		for (const edit of edits) {
			lines.push(
				`${dryRun ? 'WOULD REWRITE' : 'REWROTE'} ${directory}: package.json ${edit.script} ` +
					`(${edit.from} to ${edit.to})`,
			);
			// The one "script": "value" pair, however the file is spaced, so its layout is kept.
			const scripts = JSON.parse(text) as { scripts: Record<string, string> };
			const before = scripts.scripts[edit.script] as string;
			const pair = new RegExp(
				`(${escapePattern(JSON.stringify(edit.script))}\\s*:\\s*)${escapePattern(JSON.stringify(before))}`,
			);
			const after = before.replace(pathPattern(edit.from), (_, dot?: string) => {
				return `${dot ?? ''}${edit.to}`;
			});
			text = text.replace(pair, (_, key: string) => `${key}${JSON.stringify(after)}`);
		}
		if (!dryRun) writeFileSync(path, text);
	}
	return lines;
}
