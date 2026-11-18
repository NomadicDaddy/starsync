/**
 * The record a run reads and writes when some of its targets are linked git worktrees
 * (worktree-delivery-records-against-its-canonical-checkout; pending.ts holds the record itself).
 *
 * A worktree target is read against its canonical checkout's record: its own pending delivery if
 * one is recorded, else what the canonical checkout is confirmed to hold, which is what the
 * worktree branched from. A fleet root holding only worktrees needs no section of its own, so no
 * temporary root is adopted. What a write settles in a worktree goes to `pending` under the
 * canonical checkout, never into the confirmed record.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Lock } from './lock.ts';

import {
	deliveredBy,
	type Deliveries,
	readDeliveries,
	recordSettled,
	rootKey,
} from './deliveries.ts';
import { type Canonical, canonicalOf, readPending, recordPending } from './pending.ts';
import { withRecordLock } from './record-lock.ts';

export interface RunRecord {
	/** What the run reads, by directory under its fleet root; null when no record applies. */
	deliveries: Deliveries | null;
	/** The fleet root's own section as recorded, which only non-worktree targets settle into. */
	section: Deliveries | null;
	/** Canonical fleet roots of worktree targets that have no record there, to refuse on. */
	unrecorded: string[];
	/** Worktree targets by directory under the fleet root. */
	worktrees: Map<string, Canonical>;
}

/** Whether `path` is a checkout whose `.git` is a file: a linked worktree, or a submodule. */
function gitFile(path: string): boolean {
	const dotGit = join(path, '.git');
	return existsSync(dotGit) && statSync(dotGit).isFile();
}

/** The record a run against `fleetRoot` reads, with its worktree targets resolved through git. */
export function runRecord(ownerRoot: string, fleetRoot: string): RunRecord {
	const section = readDeliveries(ownerRoot, fleetRoot);
	const worktrees = new Map<string, Canonical>();
	const directories = existsSync(fleetRoot)
		? readdirSync(fleetRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
		: [];
	let plainRepositories = 0;
	for (const entry of directories) {
		const path = join(fleetRoot, entry.name);
		if (!gitFile(path)) {
			if (existsSync(join(path, '.git'))) plainRepositories += 1;
			continue;
		}
		const canonical = canonicalOf(path);
		if (canonical !== null) worktrees.set(entry.name, canonical);
	}
	if (worktrees.size === 0) return { deliveries: section, section, unrecorded: [], worktrees };

	const pending = readPending(ownerRoot);
	const read: Deliveries = { ...(section ?? {}) };
	const unrecorded = new Set<string>();
	for (const [directory, canonical] of worktrees) {
		const confirmed = readDeliveries(ownerRoot, canonical.fleetRoot);
		if (confirmed === null) {
			unrecorded.add(canonical.fleetRoot);
			continue;
		}
		const checkout = rootKey(join(fleetRoot, directory));
		const own = pending[rootKey(canonical.fleetRoot)]?.[canonical.directory]?.find(
			(delivery) => rootKey(delivery.checkout) === checkout,
		);
		const entry =
			own === undefined
				? confirmed[canonical.directory]
				: { commit: own.commit, groups: own.groups, version: own.version };
		if (entry === undefined) delete read[directory];
		else read[directory] = entry;
	}
	// A root that also holds an ordinary repository still needs its own section for it.
	const deliveries = section === null && plainRepositories > 0 ? null : read;
	return { deliveries, section, unrecorded: [...unrecorded].sort(), worktrees };
}

/**
 * Records what a write settled: worktree targets as pending deliveries under their canonical
 * checkout, the rest into the fleet root's own section as before (recordSettled). Never creates a
 * section for the fleet root. Returns the directories recorded.
 */
export function settleRun(
	ownerRoot: string,
	fleetRoot: string,
	record: RunRecord,
	settled: Map<string, Lock>,
): string[] {
	const ordinary = new Map(
		[...settled].filter(([directory]) => !record.worktrees.has(directory)),
	);
	const recorded: string[] = [];
	if (record.section !== null && recordSettled(ownerRoot, fleetRoot, record.section, ordinary)) {
		recorded.push(...ordinary.keys());
	}
	withRecordLock(ownerRoot, () => {
		for (const [directory, lock] of settled) {
			const canonical = record.worktrees.get(directory);
			const delivered = canonical === undefined ? null : deliveredBy(lock);
			if (canonical === undefined || delivered === null) continue;
			const checkout = join(fleetRoot, directory);
			const pending = { ...delivered, branch: canonical.branch, checkout };
			if (recordPending(ownerRoot, canonical.fleetRoot, canonical.directory, pending)) {
				recorded.push(`${directory} (pending in ${canonical.directory})`);
			}
		}
	});
	return recorded;
}
