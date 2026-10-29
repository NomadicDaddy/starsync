/**
 * `smokestack.json`'s optional `env`: the environment keys a step is handed.
 *
 * Without it a step inherits the runner's whole environment, as it always did, and the step cache
 * keys on no environment value at all, so a step whose result depends on one must be marked
 * uncacheable. With `env.pass` a step is handed only the keys listed, with their values where they
 * are set, plus the runner's own mark (gate.ts), which is always set and may not be listed. The
 * listed keys' values are part of every cached step's key, so a changed value withholds a replay.
 *
 * There is no fixed baseline: nothing reaches a step that the list does not name. What a step needs
 * to start is the list's business, PATH above all, and on Windows SystemRoot, ComSpec, PATHEXT,
 * TEMP and TMP, USERPROFILE and the rest a tool may read. Bun itself starts with none of them
 * (tried on Windows), since the runner starts the bun running the gate by its path. A baseline
 * would be keys a step sees that the file does not show and the cache key does not cover; the list
 * stays the whole answer to what a step sees and what a replay depends on.
 *
 * The list governs the process environment the runner hands a step, not every variable the step's
 * processes end up with. Bun loads .env files from its working directory into its own environment,
 * so the bun the runner starts is told not to (spawn.ts). A bun or any other tool the step's script
 * starts can still read them, which the runner cannot stop, so with a list the content of every
 * .env file Bun would load from the repository root is part of every cached step's key as well.
 *
 * Names are compared without regard to case when looking for a duplicate: Windows treats `PATH` and
 * `Path` as one variable, and a file is meant to mean the same thing on every platform.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { asObject, asText, fail } from './config-read.ts';
import { GATE_MARK } from './gate.ts';

/**
 * The files Bun loads automatically, from its environment-variables documentation (Bun 1.4.3).
 * Which of them it loads depends on NODE_ENV; all are keyed, whatever NODE_ENV is.
 */
const DOTENV_FILES = [
	'.env',
	'.env.development',
	'.env.development.local',
	'.env.local',
	'.env.production',
	'.env.production.local',
	'.env.test',
	'.env.test.local',
];

/**
 * One line per .env file Bun may load from `root`: its name and whether it is absent or else the
 * hash of its content. Only the hash leaves this function, never the content.
 */
export function dotenvState(root: string): string[] {
	return DOTENV_FILES.map((name) => {
		const path = join(root, name);
		if (!existsSync(path)) return `${name} absent`;
		const hash = new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex');
		return `${name} ${hash}`;
	});
}

export interface EnvPolicy {
	pass: string[];
}

/** Parses the top-level `env` value. Absent is null: steps inherit the whole environment. */
export function parseEnv(raw: unknown): EnvPolicy | null {
	if (raw === undefined) return null;
	const env = asObject(raw, 'env', ['pass']);
	const list = env['pass'];
	if (!Array.isArray(list) || list.length === 0) fail('env.pass must be a non-empty list.');
	const seen = new Set<string>();
	const pass = list.map((item, index) => {
		const where = `env.pass[${index}]`;
		const name = asText(item, where);
		if (name.toUpperCase() === GATE_MARK) {
			fail(`${where} names ${GATE_MARK}, which the runner always sets itself.`);
		}
		if (seen.has(name.toUpperCase())) fail(`env.pass names '${name}' twice.`);
		seen.add(name.toUpperCase());
		return name;
	});
	return { pass };
}

/**
 * The environment a step is handed, or undefined for the whole of the runner's. Called after the
 * runner has set its mark in its own environment, so the mark is read from there with the rest.
 */
export function childEnv(policy: EnvPolicy | null): Record<string, string> | undefined {
	if (policy === null) return undefined;
	const env: Record<string, string> = {};
	for (const name of [...policy.pass, GATE_MARK]) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	return env;
}

/** One line saying what a step is handed, for `--list` and `--cache-status`. */
export function describeEnv(policy: EnvPolicy | null): string {
	if (policy === null) {
		return 'env: every step inherits the whole environment (no env.pass); no value is keyed';
	}
	return `env: only ${policy.pass.join(', ')} and ${GATE_MARK}; the listed values are keyed`;
}
