/**
 * Heavy steps wait for each other across gates on one machine.
 *
 * A step marked `"heavy": true` in smokestack.json takes a turn before it runs and gives it up when
 * it ends. A heavy step of any gate on the machine, in this repository or another, starts only while
 * fewer than its own limit of earlier arrivals are waiting or running; otherwise it waits, says whose
 * steps it waits for, and starts when its turn comes. A light step never waits. Four gates at once
 * took the machine to 77 percent of its commit limit (carl #10900) and timed out other gates' tests; Phillip
 * asked for the gate to pause when a heavy one is already running, configurably (#10897). This is a
 * backstop for steps the runner runs, not the team's heavy-work slot rule: installs, builds, browser and VM
 * runs happen outside any runner step and are not seen here (Steward #52914).
 *
 * Turns are taken as in Lamport's bakery, which holds under any scheduling delay (Roger #53024). An
 * arrival first puts up a `choosing` file, reads the highest ticket in the folder, publishes its slot
 * with the next one, and takes the `choosing` file down. It runs only when nobody is choosing and its
 * slot is among the first `limit` live slots ordered by ticket and then name. An arrival paused
 * anywhere in between still has its `choosing` file up, so everyone waits for it rather than read an
 * order it is about to change; one that read the folder after another published has a later ticket.
 * A waiting arrival keeps its slot, so it keeps its place. The limit is each arrival's own: a run
 * starts while fewer than its limit are ahead of it, whatever limits the others had. What counts as
 * live, and why a gone or unknown process never lets a waiter start beside it, is heavy-files.ts.
 *
 * The slots live in one folder every account on the machine can write (heavy-config.ts).
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pid as ownPid, uptime } from 'node:process';

import type { HeavyPolicy } from './heavy-config.ts';

import {
	allSlots,
	type Entry,
	type Holder,
	liveChoosing,
	liveSlots,
	replace,
	unique,
} from './heavy-files.ts';

const POLL_MS = 500;
const TOUCH_MS = 5_000;
const REPORT_EVERY_MS = 5 * 60_000;

export type Taken =
	| { blocking: Entry[]; kind: 'timed-out'; waitedMs: number }
	| { kind: 'aborted' }
	| {
			kind: 'free';
			recordChild: (pid: number) => void;
			release: () => void;
			slot: null | string;
	  };

/**
 * One line per file that keeps this step waiting. With `files`, each names its path and the pid and
 * start time it records, so a file left by a process nobody can vouch for is one delete away
 * (Morticia #53057).
 */
export function describeBlocking(blocking: Entry[], files: boolean): string {
	if (blocking.length === 0) return 'nothing it can name';
	return blocking
		.map(({ holder, name, path }) => {
			const where = files ? ` [${path}]` : '';
			if (holder === null) return `a slot being written or unreadable${where}`;
			const recorded = files ? `, started ${holder.processStartedAt}` : '';
			if (name.startsWith('choosing-')) {
				return `${holder.repo} choosing its turn (pid ${holder.pid}${recorded})${where}`;
			}
			const minutes = Math.round((Date.now() - Date.parse(holder.takenAt)) / 60_000);
			const what = holder.state === 'running' ? 'running' : 'waiting';
			return `${holder.repo} ${holder.step} (pid ${holder.pid}${recorded}, ${what} ${minutes}m)${where}`;
		})
		.join('; ');
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((done) => {
		const timer = setTimeout(done, ms);
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				done();
			},
			{ once: true },
		);
	});
}

/** Puts up a choosing file, publishes a slot with the next ticket, and takes the choosing file down. */
function publish(policy: HeavyPolicy, holder: Holder): string {
	const choosing = join(policy.dir, `choosing-${unique()}.json`);
	writeFileSync(choosing, JSON.stringify(holder), { flag: 'wx' });
	try {
		const ticket = Math.max(0, ...allSlots(policy.dir).map((entry) => entry.ticket)) + 1;
		const slot = join(policy.dir, `slot-${ticket}-${unique()}.json`);
		writeFileSync(slot, JSON.stringify(holder), { flag: 'wx' });
		return slot;
	} finally {
		rmSync(choosing, { force: true });
	}
}

/**
 * Whether `slot` may run now, and what keeps it waiting otherwise: every live choosing file, since
 * nobody is ranked while anyone is choosing, or every live slot ahead of it, readable or not.
 */
function turn(policy: HeavyPolicy, slot: string): { blocking: Entry[]; ready: boolean } {
	const choosing = liveChoosing(policy.dir);
	if (choosing.length > 0) return { blocking: choosing, ready: false };
	const live = liveSlots(policy.dir);
	const mine = live.findIndex((entry) => entry.path === slot);
	const before = live.slice(0, mine < 0 ? live.length : mine);
	return { blocking: before, ready: before.length < policy.limit };
}

/** Takes a heavy turn for `step` of the gate at `repo`, waiting while it is not yet its turn. */
export async function takeSlot(
	policy: HeavyPolicy,
	repo: string,
	step: string,
	signal: AbortSignal,
): Promise<Taken> {
	if (policy.off !== null) {
		return { kind: 'free', recordChild: () => {}, release: () => {}, slot: null };
	}
	const mine: Holder = {
		childPid: null,
		childStartedAt: null,
		host: hostname(),
		pid: ownPid,
		processStartedAt: new Date(Date.now() - uptime() * 1000).toISOString(),
		repo,
		state: 'waiting',
		step,
		takenAt: new Date().toISOString(),
	};
	const slot = publish(policy, mine);
	const touch = setInterval(() => {
		const now = new Date();
		try {
			utimesSync(slot, now, now);
		} catch {
			// Removed by hand; the step still runs to its end.
		}
	}, TOUCH_MS);
	const release = (): void => {
		clearInterval(touch);
		rmSync(slot, { force: true });
	};
	const started = Date.now();
	let reported = 0;
	for (;;) {
		if (signal.aborted) {
			release();
			return { kind: 'aborted' };
		}
		const { blocking, ready } = turn(policy, slot);
		if (ready) {
			const running: Holder = {
				...mine,
				state: 'running',
				takenAt: new Date().toISOString(),
			};
			replace(slot, running);
			const recordChild = (childPid: number): void => {
				replace(slot, { ...running, childPid, childStartedAt: new Date().toISOString() });
			};
			return { kind: 'free', recordChild, release, slot };
		}
		const waited = Date.now() - started;
		if (waited >= policy.maxWaitMs) {
			release();
			return { blocking, kind: 'timed-out', waitedMs: waited };
		}
		if (reported === 0 || Date.now() - reported >= REPORT_EVERY_MS) {
			console.info(`    waiting for a heavy slot: ${describeBlocking(blocking, false)}`);
			reported = Date.now();
		}
		await pause(Math.min(POLL_MS, policy.maxWaitMs - waited), signal);
	}
}
