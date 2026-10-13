/**
 * `deliveries.json`: the owner's own record of what it delivered where.
 *
 * WHY IT EXISTS. The owner's sweep used to infer a past delivery from the target's lock, which is a
 * file the target can rewrite. Four reviews each found another rewrite the sweep could not see:
 * a group cut back to a declaration, a lock deleted outright, a version rewound to an older genuine
 * tag, a hook claimed as a local chain by hand. They are one fault. So the owner keeps its own
 * memory, written only by its own write, and the sweep is held to that (delivery-check.ts).
 *
 * WHAT IT IS. One untracked file at the owner's root. It names sibling directories and absolute
 * paths, so it is gitignored there and must never be tracked. It is one disk's memory: a clone does
 * not have it, and nothing can rebuild what it knew about a repository whose lock is also gone.
 *
 * ALWAYS REQUIRED, PER FLEET ROOT. The file holds one section for each fleet root the owner has
 * worked against, and a run reads and writes only the section of the root it is running against. A
 * root with no section is "no record", which fails the sweep and refuses a write. There is no
 * "nothing was ever delivered" exception, because the only evidence for one would be the targets'
 * locks, and a target can delete its lock. The section is created only by the owner's adopt
 * command; the write updates entries in a section that exists and never creates one.
 *
 * A root is identified by its REAL path, compared without regard to case on Windows. A subst
 * drive, a junction or a different spelling of the same directory is the same root, and comparing
 * the strings as typed would silently make it a second one with no record.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { platform } from 'node:process';

import { type HookClaim, isClaim, type Lock } from './lock.ts';

export const DELIVERIES_FILE = 'deliveries.json';

export interface DeliveredGroup {
	/** Present where the write recorded the group's hook as a claim, and only then. */
	claim?: HookClaim;
	/** Every installed path the delivery recorded for the group, sorted. */
	paths: string[];
}

export interface DeliveredTarget {
	commit: string;
	groups: Record<string, DeliveredGroup>;
	version: string;
}

/** One fleet root's record: target directory to what it was last delivered. */
export type Deliveries = Record<string, DeliveredTarget>;

/** The key a fleet root's section is filed under: its real path, folded where the platform folds. */
export function rootKey(fleetRoot: string): string {
	let real = resolve(fleetRoot);
	try {
		real = realpathSync.native(real);
	} catch {
		// A root that is not there has no other spelling to resolve.
	}
	return platform === 'win32' ? real.toLowerCase() : real;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asTarget(raw: unknown, where: string): DeliveredTarget {
	const fail = (message: string): never => {
		throw new Error(`${where} ${message}`);
	};
	if (!isRecord(raw)) return fail('must be an object.');
	const { commit, groups, version } = raw;
	if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit)) {
		return fail('commit must be 40 hex characters.');
	}
	if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)) {
		return fail('version must be three numbers, as in 1.2.3.');
	}
	if (!isRecord(groups)) return fail('groups must be an object.');
	const read: DeliveredTarget['groups'] = {};
	for (const [name, group] of Object.entries(groups)) {
		if (!isRecord(group)) return fail(`group '${name}' must be an object.`);
		const { claim, paths } = group;
		if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) {
			return fail(`group '${name}' paths must be a list of paths.`);
		}
		if (claim !== undefined && claim !== 'foreign-hook' && claim !== 'local-chain') {
			return fail(`group '${name}' claim is not one a write records.`);
		}
		read[name] = { paths: paths as string[], ...(claim === undefined ? {} : { claim }) };
	}
	return { commit, groups: read, version };
}

/** Every section in the owner's record, by root key. Empty when the file is not there. */
function readAll(ownerRoot: string): Record<string, Deliveries> {
	const path = join(ownerRoot, DELIVERIES_FILE);
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
	const all: Record<string, Deliveries> = {};
	for (const [root, section] of Object.entries(parsed['roots'])) {
		if (!isRecord(section)) throw new Error(`${path}: root ${root} must be an object.`);
		const read: Deliveries = {};
		for (const [directory, target] of Object.entries(section)) {
			read[directory] = asTarget(target, `${path}: ${directory} under ${root}`);
		}
		all[root] = read;
	}
	return all;
}

/**
 * The record for one fleet root, or null when the owner holds none for it. Throws on a file it
 * cannot vouch for: a record that cannot be read is not an empty one.
 */
export function readDeliveries(ownerRoot: string, fleetRoot: string): Deliveries | null {
	return readAll(ownerRoot)[rootKey(fleetRoot)] ?? null;
}

function sorted<T>(
	record: Record<string, T>,
	each: (value: T) => unknown,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(record).sort()) out[key] = each(record[key] as T);
	return out;
}

/**
 * Writes one fleet root's section and leaves every other root's as it was. Objects with sorted
 * keys, tabs, one trailing newline, so the same state is the same bytes. Returns whether the file
 * changed: a write that confirms what is already recorded touches nothing.
 */
export function writeDeliveries(
	ownerRoot: string,
	fleetRoot: string,
	section: Deliveries,
): boolean {
	const all = { ...readAll(ownerRoot), [rootKey(fleetRoot)]: section };
	const roots = sorted(all, (deliveries) =>
		sorted(deliveries, (target) => ({
			commit: target.commit,
			groups: sorted(target.groups, (group) => ({
				...(group.claim === undefined ? {} : { claim: group.claim }),
				paths: [...group.paths].sort(),
			})),
			version: target.version,
		})),
	);
	const path = join(ownerRoot, DELIVERIES_FILE);
	const content = `${JSON.stringify({ roots }, null, '\t')}\n`;
	if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
	writeFileSync(path, content);
	return true;
}

/** The claim a group's recorded files hold for its hook, or undefined where the hook is hashed. */
export function claimIn(files: Lock['groups'][string]): HookClaim | undefined {
	for (const entry of Object.values(files ?? {})) if (isClaim(entry)) return entry.claim;
	return undefined;
}

/** What a delivered lock says was delivered, in the record's shape. Null for a lock with no version. */
export function deliveredBy(lock: Lock): DeliveredTarget | null {
	if (lock.version === undefined || lock.commit === undefined) return null;
	const groups: DeliveredTarget['groups'] = {};
	for (const [name, files] of Object.entries(lock.groups)) {
		if (files === null) continue;
		const claim = claimIn(files);
		groups[name] = {
			paths: Object.keys(files).sort(),
			...(claim === undefined ? {} : { claim }),
		};
	}
	return { commit: lock.commit, groups, version: lock.version };
}
