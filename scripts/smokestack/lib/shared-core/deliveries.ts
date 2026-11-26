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
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { platform } from 'node:process';

import {
	asTarget,
	isRecord,
	type PendingRecord,
	readPendingMap,
	writtenPending,
} from './delivery-shape.ts';
import { type HookClaim, isClaim, type Lock } from './lock.ts';
import { configRoot } from './roots.ts';

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

/**
 * The sentence for an owner with no record of deliveries for the fleet root it is running against.
 * Unconditional: there is no "nothing was delivered yet" case, because the only evidence for one
 * would be the targets' locks, and a target can delete its lock.
 */
export function noRecord(fleetRoot: string): string {
	return (
		`[FAIL] There is no record of deliveries for the fleet root ${fleetRoot} in ` +
		`${DELIVERIES_FILE}. A checkout starts without one, on purpose, and only the adopt ` +
		'command creates it, from the locks that verify against this repository: ' +
		'bun run deliveries:adopt (with --fleet-root <dir> for another root).'
	);
}

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

/**
 * The whole record: every confirmed section by root key, and the deliveries into linked worktrees
 * not yet confirmed in their canonical checkout (`pending`, pending.ts). Both are checked in full
 * on every read (delivery-shape.ts), and this module carries `pending` through every write, so
 * both always change in one write.
 */
export interface RecordParts {
	pending: PendingRecord | undefined;
	roots: Record<string, Deliveries>;
}

/** The owner's whole record. Empty when the file is not there. */
export function readRecordParts(ownerRoot: string): RecordParts {
	const path = join(configRoot(ownerRoot), DELIVERIES_FILE);
	if (!existsSync(path)) return { pending: undefined, roots: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, 'utf8'));
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(`${path}: is not JSON (${reason}).`, { cause: err });
	}
	const keys = isRecord(parsed) ? Object.keys(parsed) : [];
	const pending = isRecord(parsed) ? parsed['pending'] : undefined;
	if (
		!isRecord(parsed) ||
		!isRecord(parsed['roots']) ||
		keys.some((key) => key !== 'roots' && key !== 'pending') ||
		(pending !== undefined && !isRecord(pending))
	) {
		throw new Error(`${path}: expected an object holding "roots" and optionally "pending".`);
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
	return {
		pending: pending === undefined ? undefined : readPendingMap(pending, path),
		roots: all,
	};
}

/**
 * The record for one fleet root, or null when the owner holds none for it. Throws on a file it
 * cannot vouch for: a record that cannot be read is not an empty one.
 */
export function readDeliveries(ownerRoot: string, fleetRoot: string): Deliveries | null {
	return readRecordParts(ownerRoot).roots[rootKey(fleetRoot)] ?? null;
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
 * Writes the whole record, both maps, in one write. Objects with sorted keys, tabs, one trailing
 * newline, so the same state is the same bytes. Returns whether the file changed: a write that
 * confirms what is already recorded touches nothing.
 */
export function writeRecordParts(ownerRoot: string, parts: RecordParts): boolean {
	const roots = sorted(parts.roots, (deliveries) =>
		sorted(deliveries, (target) => ({
			commit: target.commit,
			groups: sorted(target.groups, (group) => ({
				...(group.claim === undefined ? {} : { claim: group.claim }),
				paths: [...group.paths].sort(),
			})),
			version: target.version,
		})),
	);
	const path = join(configRoot(ownerRoot), DELIVERIES_FILE);
	const written = writtenPending(parts.pending ?? {});
	const pending = Object.keys(written).length === 0 ? {} : { pending: written };
	const content = `${JSON.stringify({ ...pending, roots }, null, '\t')}\n`;
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

/**
 * What the record would hold for each target a write settled, and for no others: a lock withheld
 * keeps the entry of its last good delivery, and a target outside an --only narrowing is not
 * touched. The write does not put these in the confirmed record. Its target has not decided yet
 * whether it keeps them, so each becomes a pending delivery that the reconcile confirms only once
 * the target has committed it (worktree-record.ts settleRun; shared-core-record-follows-a-
 * restored-delivery).
 *
 * Only the groups the run delivered and compared are taken from it. A group the run was narrowed
 * away from keeps the entry the record already has: copying it out of the target's lock would
 * write the target's own word into the owner's memory, which is how a hand-made claim was once
 * recorded by a write narrowed to some other group. Where such a kept entry belongs to another
 * version than this delivery, nothing is returned for that target at all, since one entry cannot
 * name two versions; the unnarrowed write settles it.
 *
 * Read from the record as it stands now rather than as it stood when the write began, so an adopt
 * or forget run meanwhile is not undone; the caller holds the record lock. `deliveries` is the
 * write's starting snapshot: a repository, or a group of one, that it held and the record no
 * longer does was forgotten while the write ran, and the forget stands (Roger #39011).
 */
export function settledEntries(
	ownerRoot: string,
	fleetRoot: string,
	deliveries: Deliveries,
	settled: Map<string, Lock>,
): Map<string, DeliveredTarget> {
	const entries = new Map<string, DeliveredTarget>();
	const section = readDeliveries(ownerRoot, fleetRoot) ?? deliveries;
	for (const [directory, lock] of settled) {
		const delivered = deliveredBy(lock);
		if (delivered === null) continue;
		const started = deliveries[directory];
		const before = section[directory];
		if (started !== undefined && before === undefined) continue;
		const forgotten = Object.keys(started?.groups ?? {}).filter(
			(name) => before?.groups[name] === undefined,
		);
		const groups = Object.fromEntries(
			Object.entries(delivered.groups).filter(([name]) => !forgotten.includes(name)),
		);
		if (Object.keys(groups).length === 0) continue;
		const entry: DeliveredTarget = { ...delivered, groups };
		const kept = Object.keys(before?.groups ?? {}).some((name) => !(name in entry.groups));
		if (kept && (before?.version !== entry.version || before.commit !== entry.commit)) {
			continue;
		}
		entries.set(directory, { ...entry, groups: { ...before?.groups, ...entry.groups } });
	}
	return entries;
}

/** Whether two entries record the same delivery, compared as the record writes them. */
export function sameDelivery(a: DeliveredTarget | undefined, b: DeliveredTarget): boolean {
	return a !== undefined && entryText(a) === entryText(b);
}

function entryText(entry: DeliveredTarget): string {
	return JSON.stringify({
		commit: entry.commit,
		groups: sorted(entry.groups, (group) => ({
			...(group.claim === undefined ? {} : { claim: group.claim }),
			paths: [...group.paths].sort(),
		})),
		version: entry.version,
	});
}
