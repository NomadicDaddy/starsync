/**
 * The package.json half of a move (move.ts): each script naming a moved file's old path once is
 * rewritten to the new one. A script naming it more than once, or a package.json with uncommitted
 * changes, is refused, because the rewrite could not then be made safely; the lead makes it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readScripts } from './targets.ts';
import { hasUncommittedChanges } from './write.ts';

export interface ScriptEdit {
	directory: string;
	from: string;
	script: string;
	to: string;
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

/** The script rewrites one target's moves need, and every reason they may not be made. */
export function planScriptEdits(
	root: string,
	directory: string,
	moves: readonly { from: string; to: string }[],
): { edits: ScriptEdit[]; refusals: string[] } {
	const edits: ScriptEdit[] = [];
	const refusals: string[] = [];
	for (const [script, value] of Object.entries(readScripts(root) ?? {})) {
		for (const move of moves) {
			const times = value.match(pathPattern(move.from))?.length ?? 0;
			if (times === 1) edits.push({ directory, from: move.from, script, to: move.to });
			else if (times > 1) {
				refusals.push(
					`${directory}: package.json script ${script} names ${move.from} ${times} times; ` +
						'rewrite it by hand to the new path.',
				);
			}
		}
	}
	if (edits.length === 0) return { edits, refusals };
	let dirty: boolean;
	try {
		dirty = hasUncommittedChanges(root, 'package.json');
	} catch (err) {
		refusals.push(`${directory}: ${err instanceof Error ? err.message : String(err)}`);
		dirty = false;
	}
	if (dirty) {
		refusals.push(
			`${directory}: package.json has uncommitted changes, so its scripts cannot be ` +
				'rewritten to the new paths.',
		);
	}
	return { edits, refusals };
}

/** Makes the rewrites of a plan with no refusals. One line per rewrite, for the write's report. */
export function applyScriptEdits(
	plan: readonly ScriptEdit[],
	fleetRoot: string,
	dryRun: boolean,
): string[] {
	const lines: string[] = [];
	const byTarget = new Map<string, ScriptEdit[]>();
	for (const edit of plan) {
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
