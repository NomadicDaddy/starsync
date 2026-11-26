/**
 * The heavy-slot folder as files: what each one says, and whether the process behind it still runs.
 * The admission rule built on these is heavy.ts.
 *
 * Two kinds of file, each with a name nobody else will ever use, so removing a stale one can never
 * remove a live one (Roger #52987):
 *   - `slot-<ticket>-<pid>-<random>.json`: a heavy step waiting for its turn or running.
 *   - `choosing-<pid>-<random>.json`: an arrival between reading the tickets and publishing its own.
 *
 * A file is live while the process that wrote it runs: its pid answers, and, for a file untouched
 * for a minute, the process behind that pid started when the file says it did, so a pid the system
 * gave to something else reads as gone (Morticia #53017). A runner that is gone still holds its slot
 * while the step it started runs, checked the same way. A process whose start time cannot be read
 * (another account) counts as running, as EPERM does: an unknown holder makes a waiter fail after
 * its maximum wait, never start beside it (Roger #53024). There is no lease on a live holder. A file
 * from another host, or one being written now, is live for a minute after its last touch.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pid as ownPid } from 'node:process';

import { processStartMs } from './process-start.ts';

const FRESH_MS = 60_000;
const START_TOLERANCE_MS = 5_000;
const SLOT_NAME = /^slot-(\d+)-\d+-[0-9a-f]+\.json$/u;
const CHOOSING_NAME = /^choosing-\d+-[0-9a-f]+\.json$/u;
const RENAME_RETRY = new Set(['EACCES', 'EBUSY', 'EPERM']);
const RENAME_TRIES = 5;
const RENAME_PAUSE_MS = 25;

export interface Holder {
	/** The step's own process once it runs, and when it started: a runner can die and leave it. */
	childPid: null | number;
	childStartedAt: null | string;
	host: string;
	pid: number;
	processStartedAt: string;
	repo: string;
	/** Waiting for its turn, or running its step. */
	state: 'running' | 'waiting';
	step: string;
	takenAt: string;
}

export interface Entry {
	holder: Holder | null;
	name: string;
	path: string;
	ticket: number;
}

/** Whether `processId` answers. Another account's process answers EPERM, which is running. */
function answers(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

const startSeen = new Map<string, { at: number; same: boolean }>();

/**
 * Whether the process at `pid` started when `startedAt` says, remembered for a minute per `key`
 * since reading a start time spawns a process. Unreadable reads as the same process.
 */
function sameStart(key: string, pid: number, startedAt: null | string): boolean {
	const seen = startSeen.get(key);
	if (seen !== undefined && Date.now() - seen.at < FRESH_MS) return seen.same;
	const actual = processStartMs(pid);
	const recorded = startedAt === null ? Number.NaN : Date.parse(startedAt);
	const same =
		actual === null ||
		Number.isNaN(recorded) ||
		Math.abs(actual - recorded) <= START_TOLERANCE_MS;
	startSeen.set(key, { at: Date.now(), same });
	return same;
}

function runs(key: string, pid: number, startedAt: null | string, idle: number): boolean {
	return answers(pid) && (idle <= FRESH_MS || sameStart(key, pid, startedAt));
}

function readHolder(path: string): Holder | null {
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as Holder;
	} catch {
		return null; // Half-written, or removed since it was listed.
	}
}

/** Whether the file at `path`, written by `holder`, still stands for a running process. */
function isLive(path: string, holder: Holder | null): boolean {
	let idle: number;
	try {
		idle = Date.now() - statSync(path).mtimeMs;
	} catch {
		return false; // Removed since it was listed.
	}
	if (holder === null || holder.host !== hostname()) return idle <= FRESH_MS;
	if (runs(path, holder.pid, holder.processStartedAt, idle)) return true;
	if (holder.childPid === null) return false;
	return runs(`${path}:child`, holder.childPid, holder.childStartedAt, idle);
}

function remove(path: string): void {
	try {
		rmSync(path, { force: true });
	} catch {
		// Another account's file: left in place, never counted.
	}
}

function names(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/** Every slot file, live or not, in admission order: by ticket, then by name. */
export function allSlots(dir: string): Entry[] {
	const found: Entry[] = [];
	for (const name of names(dir)) {
		const ticket = SLOT_NAME.exec(name)?.[1];
		if (ticket === undefined) continue;
		const path = join(dir, name);
		found.push({ holder: readHolder(path), name, path, ticket: Number(ticket) });
	}
	return found.sort((a, b) => a.ticket - b.ticket || (a.name < b.name ? -1 : 1));
}

/** The live slots in admission order, removing the stale ones this account may remove. */
export function liveSlots(dir: string): Entry[] {
	return allSlots(dir).filter((entry) => {
		if (isLive(entry.path, entry.holder)) return true;
		remove(entry.path);
		return false;
	});
}

/** The live choosing files: arrivals between reading the tickets and publishing their slot. */
export function liveChoosing(dir: string): Entry[] {
	const found: Entry[] = [];
	for (const name of names(dir)) {
		if (!CHOOSING_NAME.test(name)) continue;
		const path = join(dir, name);
		const holder = readHolder(path);
		if (isLive(path, holder)) found.push({ holder, name, path, ticket: 0 });
		else remove(path);
	}
	return found;
}

/** Whether `slot`, a heavy step's held slot, names a slot file that is live. */
export function heldSlotIsLive(slot: string): boolean {
	const name = slot.replaceAll('\\', '/').split('/').pop() ?? '';
	return SLOT_NAME.test(name) && isLive(slot, readHolder(slot));
}

/** A name part no other process will use: this runner's pid and random bytes. */
export function unique(): string {
	return `${ownPid}-${randomBytes(4).toString('hex')}`;
}

/**
 * Rewrites this runner's own slot in one step, so no waiter ever reads it half-written: a slot that
 * reads as unreadable still counts, but a truncated one would not say whose it is (Roger #53061).
 * Windows refuses a rename over a file another process has open (a waiter reading it, a scanner), so
 * it is tried a few times. If it still fails the old content stays, which names this runner and so
 * still counts as held, and the run says so instead of crashing its step (Morticia #53086). The
 * same holds when the new content can't be written at all, as on a full disk: this runs once the
 * step's process has started, so a throw would leave that process running unsupervised (Morticia
 * #53117). The temp file is removed best effort; a leftover `.next-` file names no slot, so it is
 * never counted (Morticia #53274). False when the slot could not be rewritten.
 */
export function replace(slot: string, holder: Holder): boolean {
	const next = `${slot}.next-${unique()}`;
	try {
		writeFileSync(next, JSON.stringify(holder), { flag: 'wx' });
	} catch (err) {
		remove(next);
		const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
		console.error(
			`    [WARN] could not update heavy slot ${slot} (${code}); it still counts as held`,
		);
		return false;
	}
	for (let attempt = 1; ; attempt += 1) {
		try {
			renameSync(next, slot);
			return true;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
			if (!RENAME_RETRY.has(code) || attempt >= RENAME_TRIES) {
				remove(next);
				console.error(
					`    [WARN] could not update heavy slot ${slot} (${code}); it still counts as held`,
				);
				return false;
			}
			Bun.sleepSync(RENAME_PAUSE_MS);
		}
	}
}
