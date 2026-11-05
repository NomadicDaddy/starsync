/**
 * `smokestack.json`'s optional `env`: the environment keys a step is handed.
 *
 * Without it a step inherits the runner's whole environment, as it always did, and the step cache
 * keys on no environment value but the program search path (PATH and PATHEXT, keyed either way;
 * cache.ts), so a step whose result depends on any other must be marked uncacheable. With
 * `env.pass` a step is handed only the keys listed, with their values where they are set, plus the
 * runner's own mark (gate.ts), which is always set and may not be listed. The listed keys' values
 * are part of every cached step's key, so a changed value withholds a replay.
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

/** `git rev-parse --local-env-vars` as of Git 2.5x, for when git cannot be asked. */
const GIT_LOCAL_ENV = [
	'GIT_ALTERNATE_OBJECT_DIRECTORIES',
	'GIT_COMMON_DIR',
	'GIT_CONFIG',
	'GIT_CONFIG_COUNT',
	'GIT_CONFIG_PARAMETERS',
	'GIT_DIR',
	'GIT_GRAFT_FILE',
	'GIT_IMPLICIT_WORK_TREE',
	'GIT_INDEX_FILE',
	'GIT_NO_REPLACE_OBJECTS',
	'GIT_OBJECT_DIRECTORY',
	'GIT_PREFIX',
	'GIT_REPLACE_REF_BASE',
	'GIT_SHALLOW_FILE',
	'GIT_WORK_TREE',
];

/**
 * Which of the variables git sets for the repository a hook runs in (GIT_DIR, GIT_INDEX_FILE and
 * the rest `git rev-parse --local-env-vars` names) this process was started with. A gate run from a
 * hook inherits them, and a step that makes scratch repositories then writes into the real one:
 * from a linked worktree's pre-commit, a shared-core fixture's git init made the real repository
 * bare (2026-11-05). The runner restarts itself without them (smokestack.ts), because deleting them
 * from process.env does not reach what Bun.spawnSync starts.
 */
export function gitHookEnvPresent(): string[] {
	const asked = Bun.spawnSync(['git', 'rev-parse', '--local-env-vars'], {
		stderr: 'pipe',
		stdout: 'pipe',
		windowsHide: true,
	});
	const named = asked.exitCode === 0 ? asked.stdout.toString().split(/\s+/).filter(Boolean) : [];
	return [...new Set([...GIT_LOCAL_ENV, ...named])].filter(
		(name) => process.env[name] !== undefined,
	);
}

/** Set in the restarted runner, so that a second restart is refused rather than repeated. */
export const RESTART_MARK = 'SMOKESTACK_RESTARTED_WITHOUT_GIT_HOOK_ENV';

/**
 * A copy of `env` without `names`. On Windows a variable's name is matched without regard to case,
 * so `Git_Index_File` goes with GIT_INDEX_FILE: process.env finds it under either spelling, and
 * left in the copy it would bring the restart straight back.
 */
export function withoutNames(
	env: Readonly<Record<string, string | undefined>>,
	names: readonly string[],
	ignoreCase: boolean,
): Record<string, string | undefined> {
	const key = (name: string): string => (ignoreCase ? name.toUpperCase() : name);
	const drop = new Set(names.map(key));
	return Object.fromEntries(Object.entries(env).filter(([name]) => !drop.has(key(name))));
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
		return (
			'env: every step inherits the whole environment (no env.pass); ' +
			'only PATH and PATHEXT are keyed'
		);
	}
	const handed = `env: only ${policy.pass.join(', ')} and ${GATE_MARK}`;
	return `${handed}; the listed values, PATH and PATHEXT are keyed`;
}
