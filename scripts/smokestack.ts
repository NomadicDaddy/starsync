#!/usr/bin/env bun
/**
 * The gate runner. Reads `smokestack.json` in the repository it is installed in and runs the steps
 * that file names, in order.
 *
 *   bun scripts/smokestack.ts           the full gate
 *   bun scripts/smokestack.ts --fast    the fast gate: a named subset, for a commit
 *   bun scripts/smokestack.ts --list    print the steps either would run, and run nothing
 *
 * Exit codes: 0 every step passed; 1 at least one step failed; 2 the run could not start (a bad
 * flag, no config or a bad one, no lock or one this runner cannot check itself against); 130 it
 * was interrupted.
 *
 * The root is the repository this file is installed in: the parent of the `scripts` directory it
 * sits in. It is never searched for, and never the directory the command was started from, so a
 * repository with no config cannot end up running an ancestor's gate.
 */
import { dirname, join, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { parseArgs } from 'node:util';

import { readScripts } from './lib/shared-core/targets.ts';
import { type Config, ConfigError, readConfig, type Step } from './lib/smokestack/config.ts';
import { exitCodeFor, GATE_MARK, type Mode, runGate, summarise } from './lib/smokestack/gate.ts';
import { standing } from './lib/smokestack/preflight.ts';

const USAGE = 'Usage: bun scripts/smokestack.ts [--fast] [--list]';
const EXIT_CANNOT_START = 2;

export interface RunnerOptions {
	fast: boolean;
	list: boolean;
}

export function parseRunnerArgs(args: string[]): RunnerOptions {
	const { values } = parseArgs({
		allowPositionals: false,
		args,
		options: { fast: { type: 'boolean' }, list: { type: 'boolean' } },
		strict: true,
	});
	return { fast: values.fast === true, list: values.list === true };
}

function selectSteps(config: Config, mode: Mode): Step[] {
	if (mode === 'qc') return config.qc;
	if (config.fast === null) {
		throw new ConfigError('smokestack.json: --fast was asked for and no fast gate is defined.');
	}
	return config.fast;
}

function list(steps: Step[], mode: Mode): void {
	console.log(`smokestack: ${mode}, ${steps.length} step(s), nothing run`);
	for (const step of steps) console.log(`${step.name}\t${step.run.join(' ')}`);
}

/** Runs the gate for the repository at `root`. `signal` stops it; see gate.ts. */
export async function runSmokestack(
	options: RunnerOptions,
	root: string,
	signal: AbortSignal,
): Promise<number> {
	const mode: Mode = options.fast ? 'fast' : 'qc';
	let config: Config;
	let steps: Step[];
	try {
		config = readConfig(root, readScripts(root));
		steps = selectSteps(config, mode);
	} catch (err) {
		if (!(err instanceof ConfigError)) throw err;
		console.error(`[FAIL] ${err.message}`);
		return EXIT_CANNOT_START;
	}
	if (options.list) {
		list(steps, mode);
		return 0;
	}

	let stand: ReturnType<typeof standing>;
	try {
		stand = standing(root, mode);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		console.error(`[FAIL] smokestack cannot check this repository against its lock: ${reason}`);
		return EXIT_CANNOT_START;
	}
	if (stand.state === 'refused') {
		console.error(`[FAIL] smokestack will not start: ${stand.reason}.`);
		return EXIT_CANNOT_START;
	}

	if (process.env[GATE_MARK] !== undefined) {
		console.error(
			'[FAIL] smokestack will not start: it was started by a step of a gate that is already ' +
				'running. A step must not run the gate.',
		);
		return EXIT_CANNOT_START;
	}
	process.env[GATE_MARK] = '1';

	console.log(`smokestack ${stand.version}: ${mode}, ${steps.length} step(s)`);
	if (stand.preflight === null) {
		console.log('This repository is the owner of what it would check itself against; no lock.');
	}
	const started = Date.now();
	const result = await runGate({ mode, preflight: stand.preflight, root, signal, steps });
	summarise(result, mode, config.qc.length, Date.now() - started);
	return exitCodeFor(result);
}

if (import.meta.main) {
	let options: RunnerOptions;
	try {
		options = parseRunnerArgs(argv.slice(2));
	} catch (err) {
		console.error(`[FAIL] ${err instanceof Error ? err.message : String(err)}`);
		console.error(USAGE);
		exit(EXIT_CANNOT_START);
	}
	const root = resolve(join(dirname(import.meta.path), '..'));
	const stop = new AbortController();
	for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
		process.on(name, () => {
			stop.abort();
		});
	}
	exit(await runSmokestack(options, root, stop.signal));
}
