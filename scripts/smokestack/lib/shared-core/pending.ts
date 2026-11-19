/**
 * Deliveries into linked git worktrees, recorded against their canonical checkout and held apart
 * until the canonical checkout is confirmed to hold them (worktree-delivery-records-against-its-
 * canonical-checkout).
 *
 * A target that is a linked worktree is the same repository as its canonical checkout, which git
 * names through its common directory. So the delivery belongs to the canonical checkout's fleet
 * root and repository name, whatever the worktree folder is called, and no temporary root is
 * adopted. But the bytes are in the worktree, not in the canonical checkout, until its branch
 * merges. So the delivery is recorded here, in `pending`, naming the checkout and branch written,
 * and the confirmed record (`roots`) is left as it was. Readers of the confirmed record never see
 * a pending delivery, and the canonical checkout is never reported as holding bytes it may not
 * hold. A reconcile after the merge confirms it (shared-core-deliveries.ts reconcile).
 *
 * `pending` is one optional key in deliveries.json beside `roots`, so both change in one write
 * under the record lock: `{ <canonical root key>: { <directory>: [<one per checkout>] } }`.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { PendingDelivery, PendingRecord } from './delivery-shape.ts';

import { type Deliveries, readRecordParts, rootKey, writeRecordParts } from './deliveries.ts';

/** Where a linked worktree's canonical checkout is, as git names it. */
export interface Canonical {
	branch: string;
	directory: string;
	fleetRoot: string;
}

function git(cwd: string, args: string[]): null | string {
	const run = Bun.spawnSync(['git', '-C', cwd, ...args], {
		stderr: 'pipe',
		stdout: 'pipe',
		windowsHide: true,
	});
	return run.exitCode === 0 ? run.stdout.toString().trim() : null;
}

/**
 * The canonical checkout of `target` when `target` is a linked worktree, else null (a canonical
 * checkout, or not a repository at all). Paths are compared as git and the file system resolve
 * them (rootKey), never as typed, so a subst drive or a junction spelling is the same checkout.
 */
export function canonicalOf(target: string): Canonical | null {
	const common = git(target, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
	const own = git(target, ['rev-parse', '--absolute-git-dir']);
	if (common === null || own === null || rootKey(common) === rootKey(own)) return null;
	// A linked worktree of a bare repository has no canonical checkout to record it against.
	if (basename(common) !== '.git') {
		throw new Error(
			`${target}: its repository ${common} has no working checkout to record it in.`,
		);
	}
	const checkout = dirname(common);
	return {
		branch: branchOf(target),
		directory: basename(checkout),
		fleetRoot: dirname(checkout),
	};
}

/** The branch `checkout` has checked out, or HEAD where it is detached or cannot be read. */
export function branchOf(checkout: string): string {
	return git(checkout, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'HEAD';
}

/**
 * The folder under `fleetRoot` that is a linked worktree of the repository named `name`, when no
 * folder there carries that name itself: a worktree is usually named for its task, not its project.
 * Two worktrees of that repository there is ambiguous and refused, never settled by listing order
 * (Roger and Morticia, 95427f3).
 */
export function worktreeFor(fleetRoot: string, name: string): null | string {
	if (!existsSync(fleetRoot)) return null;
	const found: string[] = [];
	for (const entry of readdirSync(fleetRoot, { withFileTypes: true })) {
		const path = join(fleetRoot, entry.name);
		const dotGit = join(path, '.git');
		if (!entry.isDirectory() || !existsSync(dotGit) || !statSync(dotGit).isFile()) continue;
		if (canonicalOf(path)?.directory === name) found.push(entry.name);
	}
	if (found.length > 1) {
		throw new Error(
			`${fleetRoot} holds ${String(found.length)} worktrees of ${name} (${found.sort().join(', ')}), ` +
				'so which one the roster means is ambiguous. Pass one worktree parent per run.',
		);
	}
	if (found.length === 1) return found[0] ?? null;
	return null;
}

/** Every pending delivery in the owner's record, checked in full as it is read (delivery-shape.ts). */
export function readPending(ownerRoot: string): PendingRecord {
	return readRecordParts(ownerRoot).pending ?? {};
}

/**
 * Replaces the pending record, and the confirmed one with `roots` when given (else as it is), in
 * one write, so a reconcile's promotion is one change of both. Caller holds the record lock.
 */
export function writePending(
	ownerRoot: string,
	record: PendingRecord,
	roots: Record<string, Deliveries> = readRecordParts(ownerRoot).roots,
): boolean {
	return writeRecordParts(ownerRoot, { pending: record, roots });
}

/**
 * Records one delivery, into a worktree or into the canonical checkout itself, under the canonical
 * checkout, replacing that checkout's earlier pending delivery and keeping every other checkout's.
 * Caller holds the record lock.
 */
export function recordPending(
	ownerRoot: string,
	canonicalFleetRoot: string,
	directory: string,
	delivery: PendingDelivery,
): boolean {
	return replacePending(ownerRoot, canonicalFleetRoot, directory, delivery.checkout, delivery);
}

/**
 * Drops the pending delivery recorded for `checkout`, as when a write leaves it holding exactly
 * what is already confirmed there. Caller holds the record lock. Returns whether the file changed.
 */
export function clearPending(
	ownerRoot: string,
	canonicalFleetRoot: string,
	directory: string,
	checkout: string,
): boolean {
	return replacePending(ownerRoot, canonicalFleetRoot, directory, checkout, null);
}

function replacePending(
	ownerRoot: string,
	canonicalFleetRoot: string,
	directory: string,
	checkout: string,
	delivery: null | PendingDelivery,
): boolean {
	const record = readPending(ownerRoot);
	const key = rootKey(canonicalFleetRoot);
	const section = record[key] ?? {};
	const others = (section[directory] ?? []).filter(
		(entry) => rootKey(entry.checkout) !== rootKey(checkout),
	);
	record[key] = { ...section, [directory]: delivery === null ? others : [...others, delivery] };
	return writePending(ownerRoot, record);
}
