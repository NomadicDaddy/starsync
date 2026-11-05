/**
 * FROZEN TARGETS. Some repositories must not be written to for a while: they hold work that cannot
 * take a commit. The sync writes to every target its model resolves, so a write that is not
 * narrowed with `--only` reaches them. Which repositories are frozen is a fact about this machine
 * and names private siblings, so the list lives in an untracked file beside package.json, as the
 * rosters do, and only its `.example` is tracked. While the list names anything, a write is
 * refused when it is not narrowed, and when its narrowing names a frozen target. A dry run is
 * refused the same way, so the rehearsal and the write obey one rule.
 *
 * One rule, read in three places: the sync's own write (sync-shared-core.ts, owner path only, so
 * a consumer never reads the list), the sanctioned `shared-core:write` wrapper, and both fleet
 * installers before they prepare dispatch (guard-install/preflight.ts).
 *
 * A missing list is a refusal too. Absent could mean nothing is frozen or could mean a fresh
 * checkout that was never told, and only the first is safe to write from; an empty array is how a
 * person states the first.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FROZEN_FILE = 'frozen-targets.json';

/** The frozen list, or null when this checkout has none. Throws on a list it cannot read. */
export function loadFrozen(root: string): null | string[] {
	const path = join(root, FROZEN_FILE);
	if (!existsSync(path)) return null;
	const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
	if (
		!Array.isArray(parsed) ||
		parsed.some((entry) => typeof entry !== 'string' || entry.trim() === '')
	) {
		throw new Error(`${path}: expected an array of directory names, each a name or a prefix*.`);
	}
	// Trimmed, because an entry is matched whole: ' tree' with a stray space matches no directory
	// and would freeze nothing while reading as though it did.
	return (parsed as string[]).map((entry) => entry.trim());
}

/**
 * An entry is one directory name, or a prefix ending in `*` that covers a repository's worktrees.
 * The prefix does not cover the repository itself unless the name continues past it: `app-*`
 * freezes `app-2` and not `app`, so freezing both takes two entries.
 */
function isFrozen(frozen: string[], directory: string): boolean {
	const name = directory.toLowerCase();
	return frozen.some((entry) => {
		const pattern = entry.toLowerCase();
		return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
	});
}

/** The reason a run may not write while targets are frozen, or null when it may. */
export function frozenRefusal(frozen: null | string[], only?: Iterable<string>): null | string {
	if (frozen === null) {
		return (
			`${FROZEN_FILE} is missing beside package.json, so this cannot tell which targets are ` +
			`frozen. Copy ${FROZEN_FILE}.example, list every directory that must not be written ` +
			'to, or write [] to state that none is.'
		);
	}
	if (frozen.length === 0) return null;
	const named = only === undefined ? [] : [...only];
	if (named.length === 0) {
		return (
			`${FROZEN_FILE} declares ${frozen.length} frozen target pattern(s) and this run is not ` +
			'narrowed with --only, so the write would reach them. Name the targets to write with ' +
			'--only <csv>.'
		);
	}
	const held = named.filter((directory) => isFrozen(frozen, directory));
	if (held.length > 0) return `--only names frozen target(s): ${held.join(', ')}.`;
	return null;
}
