/**
 * Runs a gate's steps in order and says what happened to each.
 *
 * The full gate runs every step even after one fails, then lists what failed: a gate that takes
 * minutes and stops at its first failure makes each failure cost a whole run to find. The fast gate
 * stops at the first, because it runs inside a commit and the commit is refused either way.
 *
 * An interruption is not a failure. It stops the running step with everything that step started,
 * runs nothing further, and is reported as an interruption with the count of steps that did not
 * run. It is never recorded as a failed step followed by more work.
 *
 * The summary counts what happened. A step is passed only when its process ended with 0, or when
 * the step cache replays a pass recorded over the same key and inputs (cache.ts); a replay is
 * counted with the passes and said to be one.
 */
import type { CacheSession } from './cache.ts';
import type { Step } from './config.ts';

import { runProcess } from './spawn.ts';

export type Mode = 'fast' | 'qc';

interface Failure {
	detail: string;
	name: string;
}

export interface GateResult {
	failures: Failure[];
	interrupted: boolean;
	notRun: number;
	passed: number;
	/** Of the passed, how many were replayed from the cache. */
	replayed: number;
	selected: number;
}

/** A check made before the steps and reported as the first of them. */
export interface Preflight {
	/** Printed under the heading, one per line. */
	lines: string[];
	name: string;
	passed: boolean;
}

export interface GateOptions {
	/** Null when the config declares no cache: every step runs. */
	cache: CacheSession | null;
	/** What every step is handed; undefined for the runner's whole environment (env.ts). */
	env: Record<string, string> | undefined;
	mode: Mode;
	preflight: null | Preflight;
	root: string;
	signal: AbortSignal;
	steps: Step[];
}

/**
 * Set in the runner's own environment before its first step, and so handed to every step, whatever
 * the config's `env.pass` lists (env.ts). A
 * runner that finds it set was started by a step of another run, and refuses: a step that runs the
 * gate starts the gate inside itself without end. The config reader refuses the spellings of that
 * it can recognise in text; this catches the rest, however the step reached the runner.
 */
export const GATE_MARK = 'SMOKESTACK_GATE_RUNNING';

/** Exit codes. 2 is reserved for a run that could not start, decided before this module. */
const EXIT_PASSED = 0;
const EXIT_FAILED = 1;
export const EXIT_INTERRUPTED = 130;

function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function reportPreflight(preflight: Preflight, result: GateResult): void {
	console.log(`==> ${preflight.name}`);
	for (const line of preflight.lines) console.log(`    ${line}`);
	if (preflight.passed) {
		console.log(`[PASS] ${preflight.name}`);
		result.passed += 1;
		return;
	}
	console.error(`[FAIL] ${preflight.name}`);
	result.failures.push({ detail: 'see above', name: preflight.name });
}

async function runOne(step: Step, options: GateOptions, result: GateResult): Promise<void> {
	const { cache } = options;
	const assessed = cache === null || step.cache === null ? null : await cache.assess(step);
	if (assessed?.replay === true) {
		console.log(`[CACHED] ${step.name} (${assessed.reason})`);
		result.passed += 1;
		result.replayed += 1;
		return;
	}
	console.log(`==> ${step.name}`);
	console.log(`    ${step.run.join(' ')}`);
	if (assessed !== null) console.log(`    cache: runs, ${assessed.reason}`);
	const started = Date.now();
	const ended = await runProcess(step.run, options.root, options.env, options.signal);
	const took = seconds(Date.now() - started);
	if (ended.state === 'stopped') {
		result.interrupted = true;
		console.error(`[STOPPED] ${step.name} ${took}`);
		return;
	}
	if (ended.state === 'could-not-start') {
		console.error(`[FAIL] ${step.name} (could not start: ${ended.reason})`);
		result.failures.push({ detail: 'could not start', name: step.name });
		if (assessed !== null) cache?.forget(step);
		return;
	}
	if (ended.code !== 0) {
		console.error(`[FAIL] ${step.name} (exit ${ended.code}) ${took}`);
		result.failures.push({ detail: `exit ${ended.code}`, name: step.name });
		if (assessed !== null) cache?.forget(step);
		return;
	}
	console.log(`[PASS] ${step.name} ${took}`);
	result.passed += 1;
	if (cache !== null && assessed !== null && assessed.before !== null) {
		console.log(`    cache: ${await cache.record(step, assessed.before)}`);
	}
}

/** Runs the gate and prints each step. The summary is printed by `summarise`. */
export async function runGate(options: GateOptions): Promise<GateResult> {
	const { mode, preflight, steps } = options;
	const result: GateResult = {
		failures: [],
		interrupted: false,
		notRun: 0,
		passed: 0,
		replayed: 0,
		selected: steps.length + (preflight === null ? 0 : 1),
	};
	if (preflight !== null) reportPreflight(preflight, result);

	for (const [index, step] of steps.entries()) {
		const stop = options.signal.aborted || (mode === 'fast' && result.failures.length > 0);
		if (stop) {
			result.interrupted ||= options.signal.aborted;
			result.notRun = steps.length - index;
			break;
		}
		await runOne(step, options, result);
		if (result.interrupted) {
			// The stopped step did not finish, so it is counted with those that did not run.
			result.notRun = steps.length - index;
			break;
		}
	}
	return result;
}

export function exitCodeFor(result: GateResult): number {
	if (result.interrupted) return EXIT_INTERRUPTED;
	return result.failures.length > 0 ? EXIT_FAILED : EXIT_PASSED;
}

/**
 * The last lines of a run. `fullCount` is the number of steps in the full gate, so a fast run says
 * in its verdict that it was not the full gate: people and tools read this line as the result.
 */
export function summarise(result: GateResult, mode: Mode, fullCount: number, ms: number): void {
	const scope =
		mode === 'fast' ? ` (fast subset of ${fullCount} qc steps, not the full gate)` : '';
	const replayed = result.replayed > 0 ? ` (${result.replayed} replayed from the cache)` : '';
	const counts =
		`${result.selected} selected, ${result.passed} passed${replayed}, ` +
		`${result.failures.length} failed, ${result.notRun} not run`;
	if (result.interrupted) {
		console.error(`smokestack: ${mode} INTERRUPTED${scope}: ${counts} (${seconds(ms)})`);
		return;
	}
	if (result.failures.length === 0) {
		console.log(`smokestack: ${mode} passed${scope}: ${counts} (${seconds(ms)})`);
		return;
	}
	console.error(`smokestack: ${mode} FAILED${scope}: ${counts} (${seconds(ms)})`);
	for (const failure of result.failures) {
		console.error(`  [FAIL] ${failure.name} (${failure.detail})`);
	}
}
