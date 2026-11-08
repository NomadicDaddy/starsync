/**
 * `departed.json`: the owner's memory of every repository it has forgotten a delivery to.
 *
 * WHY IT EXISTS. A repository with no lock that the record of deliveries does not name may take
 * the lockless allowance (behind-lockless.ts). `deliveries:forget` removes a repository from that
 * record, so without this memory a repository the writer DID deliver to could lose its lock (even
 * one it never committed) and be forgotten, and then pass as an installer's copy. Forgetting is
 * therefore remembered here, and a repository named here never takes the allowance.
 *
 * WHAT IT IS. One untracked file beside deliveries.json at the owner's config root, gitignored
 * like it, holding `{ "roots": { <root key>: [directory, ...] } }`. Root keys are deliveries.ts's
 * rootKey. A forget appends its directory BEFORE it rewrites deliveries.json, so a run that stops
 * between the two leaves the repository departed and still recorded, which grants nothing. Nothing
 * removes a name. adopt creates a root's empty list where there is none.
 *
 * FAILS CLOSED. A root with no list here grants no lockless allowance at all: an owner that has
 * never forgotten anything holds an empty list, created by adopt. The file is kept apart from
 * deliveries.json because that file's reader accepts nothing but "roots", and a new key there
 * would break every older smokestack checkout that reads the same record. The one residual is a
 * person deleting this untracked file by hand, the same trust the record itself rests on.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { rootKey } from './deliveries.ts';
import { configRoot } from './roots.ts';

export const DEPARTED_FILE = 'departed.json';

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Every root's list, by root key. Empty when the file is not there; throws on one it can't read. */
function readAll(ownerRoot: string): Record<string, string[]> {
	const path = join(configRoot(ownerRoot), DEPARTED_FILE);
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, 'utf8'));
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(`${path}: is not JSON (${reason}).`, { cause: err });
	}
	if (!isRecord(parsed) || !isRecord(parsed['roots']) || Object.keys(parsed).length !== 1) {
		throw new Error(`${path}: expected an object holding only "roots".`);
	}
	const all: Record<string, string[]> = {};
	for (const [root, list] of Object.entries(parsed['roots'])) {
		if (!Array.isArray(list) || list.some((name) => typeof name !== 'string')) {
			throw new Error(`${path}: root ${root} must be a list of directory names.`);
		}
		all[root] = list as string[];
	}
	return all;
}

function writeAll(ownerRoot: string, all: Record<string, string[]>): void {
	const roots: Record<string, string[]> = {};
	for (const key of Object.keys(all).sort()) roots[key] = [...new Set(all[key])].sort();
	const path = join(configRoot(ownerRoot), DEPARTED_FILE);
	writeFileSync(path, `${JSON.stringify({ roots }, null, '\t')}\n`);
}

/** The directories forgotten under `fleetRoot`, or null where the owner keeps no list for it. */
export function readDeparted(ownerRoot: string, fleetRoot: string): null | Set<string> {
	const list = readAll(ownerRoot)[rootKey(fleetRoot)];
	return list === undefined ? null : new Set(list);
}

/**
 * The sweep's read: as readDeparted, except that a file it cannot read is reported and read as no
 * list. Either way the lockless allowance is withheld: the fail-closed default, not a failure.
 */
export function departedOrNone(ownerRoot: string, fleetRoot: string): null | Set<string> {
	try {
		return readDeparted(ownerRoot, fleetRoot);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		console.error(`[WARN] ${reason} No repository takes the lockless allowance.`);
		return null;
	}
}

/** Gives `fleetRoot` an empty list where it has none; leaves an existing list exactly as it is. */
export function ensureDeparted(ownerRoot: string, fleetRoot: string): void {
	const all = readAll(ownerRoot);
	const key = rootKey(fleetRoot);
	if (all[key] !== undefined) return;
	writeAll(ownerRoot, { ...all, [key]: [] });
}

/** Adds `directory` to `fleetRoot`'s list, creating the list where there is none. */
export function recordDeparted(ownerRoot: string, fleetRoot: string, directory: string): void {
	const all = readAll(ownerRoot);
	const key = rootKey(fleetRoot);
	writeAll(ownerRoot, { ...all, [key]: [...(all[key] ?? []), directory] });
}
