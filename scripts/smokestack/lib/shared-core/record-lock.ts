/**
 * The owner's record lock: one file, created exclusively next to deliveries.json, held by every
 * command that changes deliveries.json or departed.json, and by a write for the whole of its run.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { closeSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pid } from 'node:process';

import { configRoot } from './roots.ts';

/** Held, as a file created exclusively, by every read-modify-write of this record or departed.json. */
export const RECORD_LOCK_FILE = 'deliveries.lock';
const LOCK_WAIT_MS = 30_000;

/**
 * Runs `action` holding the owner's record lock, so that no two commands that change
 * deliveries.json or departed.json interleave (Roger #38819: two forgets each overwrote the
 * other's departed entry, and one repository ended in neither file). It waits up to thirty seconds
 * for another holder, then refuses. A lock left by a command that died is not taken over: the
 * refusal names the file, to be removed by hand once nothing is running.
 */
export function withRecordLock<T>(ownerRoot: string, action: () => T): T {
	const path = join(configRoot(ownerRoot), RECORD_LOCK_FILE);
	// Held already by this process (a write holds it throughout): run inside the same hold.
	if (held.has(path)) return action();
	const fd = acquire(path);
	held.add(path);
	try {
		return action();
	} finally {
		release(path, fd);
	}
}

/**
 * Takes the owner's record lock for the rest of this process, as a write does before it reads the
 * record: everything it settles is then decided and written inside one hold, so no adopt or forget
 * can land in between and be undone (Roger #39011, #39124). Released when the process exits, and
 * on SIGINT, SIGTERM and SIGHUP too, which would otherwise end the process without running exit
 * handlers and leave the lock for every later command to refuse on (Morticia, c646a32 review). A
 * process killed outright (taskkill /F, a crash) still leaves it: the refusal names the file.
 */
export function holdRecordLockUntilExit(ownerRoot: string): void {
	const path = join(configRoot(ownerRoot), RECORD_LOCK_FILE);
	if (held.has(path)) return;
	const fd = acquire(path);
	held.add(path);
	process.once('exit', () => release(path, fd));
	for (const [name, code] of SIGNAL_EXIT) {
		process.once(name, () => {
			release(path, fd);
			process.exit(code);
		});
	}
}

/** The signals a write is stopped with, and the exit code each gives (128 + its number). */
const SIGNAL_EXIT = [
	['SIGINT', 130],
	['SIGTERM', 143],
	['SIGHUP', 129],
] as const;

/** Lock files this process holds, by path. */
const held = new Set<string>();

function acquire(path: string): number {
	const until = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			const fd = openSync(path, 'wx');
			writeFileSync(fd, `${pid} ${new Date().toISOString()}\n`);
			return fd;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
			if (Date.now() > until) {
				throw new Error(
					`${path} is held by another command that changes the record of deliveries. If none ` +
						'is running, a command died holding it: remove the file and run this again.',
					{ cause: err },
				);
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
		}
	}
}

/** Releases a lock this process holds; a second call for the same hold does nothing. */
function release(path: string, fd: number): void {
	if (!held.delete(path)) return;
	closeSync(fd);
	rmSync(path, { force: true });
}
