/**
 * The record a run reads and writes, with what its write settled held as pending until the target
 * has kept it (worktree-delivery-records-against-its-canonical-checkout and shared-core-record-
 * follows-a-restored-delivery; pending.ts holds the pending record itself).
 *
 * A worktree target is read against its canonical checkout's record: its own pending delivery if
 * one is recorded, else what the canonical checkout is confirmed to hold, which is what the
 * worktree branched from. A fleet root holding only worktrees needs no section of its own, so no
 * temporary root is adopted.
 *
 * A write into a canonical checkout is made before that checkout's own gate decides it: the target
 * commits it on green and restores it from HEAD on red. So what a write settles anywhere goes to
 * `pending`, never into the confirmed record, and the reconcile confirms it once the target has
 * committed it, or cancels it once the target is back on what is confirmed. Meanwhile a canonical
 * checkout whose lock names its pending delivery is read against that delivery, so the sweep holds
 * the written files to what was written; one whose lock does not is read against the confirmed
 * record, as a restored one is.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { PendingDelivery } from './delivery-shape.ts';

import {
	deliveredBy,
	type Deliveries,
	readDeliveries,
	rootKey,
	sameDelivery,
	settledEntries,
} from './deliveries.ts';
import { type Lock, readLock } from './lock.ts';
import {
	branchOf,
	type Canonical,
	canonicalOf,
	clearPending,
	readPending,
	recordPending,
} from './pending.ts';
import { withRecordLock } from './record-lock.ts';

export interface RunRecord {
	/** What the run reads, by directory under its fleet root; null when no record applies. */
	deliveries: Deliveries | null;
	/** Canonical checkouts read against their own pending delivery, with its version. */
	pendingHeld: Map<string, string>;
	/** The fleet root's own section as recorded. */
	section: Deliveries | null;
	/** Canonical fleet roots of worktree targets that have no record there, to refuse on. */
	unrecorded: string[];
	/** Worktree targets by directory under the fleet root. */
	worktrees: Map<string, Canonical>;
	/**
	 * Canonical checkouts under the fleet root with a pending delivery of their own, whatever their
	 * lock now says. A write was made there, so none of them is an installer's copy (behind.ts).
	 */
	written: Set<string>;
}

/** Whether `path` is a checkout whose `.git` is a file: a linked worktree, or a submodule. */
function gitFile(path: string): boolean {
	const dotGit = join(path, '.git');
	return existsSync(dotGit) && statSync(dotGit).isFile();
}

/** The pending delivery recorded for `checkout` itself among `list`, if any. */
function ownPending(
	list: PendingDelivery[] | undefined,
	checkout: string,
): PendingDelivery | undefined {
	const key = rootKey(checkout);
	return list?.find((delivery) => rootKey(delivery.checkout) === key);
}

/** Whether the lock in `checkout` names `delivery`'s version and commit. Unreadable is no. */
function lockNames(checkout: string, delivery: PendingDelivery): boolean {
	try {
		const lock = readLock(checkout);
		return lock?.version === delivery.version && lock.commit === delivery.commit;
	} catch {
		return false;
	}
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

	const pending = readPending(ownerRoot);
	const read: Deliveries = { ...(section ?? {}) };
	const pendingHeld = new Map<string, string>();
	const written = new Set<string>();
	if (section !== null) {
		for (const [directory, list] of Object.entries(pending[rootKey(fleetRoot)] ?? {})) {
			const checkout = join(fleetRoot, directory);
			const own = ownPending(list, checkout);
			if (own === undefined) continue;
			written.add(directory);
			if (!lockNames(checkout, own)) continue;
			read[directory] = { commit: own.commit, groups: own.groups, version: own.version };
			pendingHeld.set(directory, own.version);
		}
	}
	if (worktrees.size === 0) {
		const deliveries = section === null ? null : read;
		return { deliveries, pendingHeld, section, unrecorded: [], worktrees, written };
	}

	const unrecorded = new Set<string>();
	for (const [directory, canonical] of worktrees) {
		const confirmed = readDeliveries(ownerRoot, canonical.fleetRoot);
		if (confirmed === null) {
			unrecorded.add(canonical.fleetRoot);
			continue;
		}
		const own = ownPending(
			pending[rootKey(canonical.fleetRoot)]?.[canonical.directory],
			join(fleetRoot, directory),
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
	const sorted = [...unrecorded].sort();
	return { deliveries, pendingHeld, section, unrecorded: sorted, worktrees, written };
}

/**
 * Records what a write settled, all of it as pending: worktree targets under their canonical
 * checkout, the rest under their own directory in the fleet root's section, each with the entry
 * the confirmed record would take from it (settledEntries). A target left holding exactly what is
 * already confirmed there has nothing pending. Never creates a section for the fleet root. Returns
 * the directories recorded.
 */
export function settleRun(
	ownerRoot: string,
	fleetRoot: string,
	record: RunRecord,
	settled: Map<string, Lock>,
): string[] {
	const recorded: string[] = [];
	withRecordLock(ownerRoot, () => {
		const { section } = record;
		if (section !== null) {
			const ordinary = new Map(
				[...settled].filter(([directory]) => !record.worktrees.has(directory)),
			);
			const confirmed = readDeliveries(ownerRoot, fleetRoot) ?? {};
			for (const [directory, entry] of settledEntries(
				ownerRoot,
				fleetRoot,
				section,
				ordinary,
			)) {
				const checkout = join(fleetRoot, directory);
				if (sameDelivery(confirmed[directory], entry)) {
					clearPending(ownerRoot, fleetRoot, directory, checkout);
					continue;
				}
				const pending = { ...entry, branch: branchOf(checkout), checkout };
				if (recordPending(ownerRoot, fleetRoot, directory, pending)) {
					recorded.push(`${directory} (pending until its commit is reconciled)`);
				}
			}
		}
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
