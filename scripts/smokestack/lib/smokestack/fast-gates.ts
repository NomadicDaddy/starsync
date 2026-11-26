/**
 * Delivered gates that must run in a repository's fast gate (static-delivered-gates-run-in-fast).
 *
 * A gate in smokestack's manifest may carry `"fast": true`: it is static, read-only and quick
 * enough for every commit. A consumer's fast.steps is its own to write and is not delivered, so
 * two spernakit refactors once passed the fast gate, merged and left main red on a gate that only
 * the full gate ran (Edgar #61055). So a qc step that runs a fast-marked gate must be in fast.steps,
 * and a fast.replace for it must still run that gate. A config that breaks this is refused like any
 * other config mistake, before a step starts.
 *
 * The marks are read from the manifest beside the config that names the steps: smokestack's own
 * scripts/shared-core-manifest.json for its root smokestack.json, and the delivered
 * scripts/smokestack/shared-core-manifest.json for a consumer's scripts/smokestack/smokestack.json.
 * A repository whose manifest marks nothing, or that has no fast gate, is unaffected.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Step } from './config.ts';

import { fail } from './config-read.ts';

const MANIFEST_FILE = 'shared-core-manifest.json';

/** The manifest beside the config at `configFile` in the repository at `root`. */
export function manifestBeside(root: string, configFile: string): string {
	const home = dirname(configFile);
	return home === root ? join(root, 'scripts', MANIFEST_FILE) : join(home, MANIFEST_FILE);
}

/** The package scripts of every gate the manifest marks fast. A missing manifest marks nothing. */
function fastGateScripts(manifestFile: string): Set<string> {
	let text: string;
	try {
		text = readFileSync(manifestFile, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
		throw err;
	}
	let groups: unknown;
	try {
		groups = (JSON.parse(text) as { groups?: unknown }).groups;
	} catch (err) {
		fail(`cannot read the fast gates: ${manifestFile} is not JSON (${String(err)}).`);
	}
	const scripts = new Set<string>();
	for (const group of Array.isArray(groups) ? (groups as Record<string, unknown>[]) : []) {
		const gates = Array.isArray(group['gates'])
			? (group['gates'] as Record<string, unknown>[])
			: [];
		for (const gate of gates)
			if (gate['fast'] === true && typeof gate['script'] === 'string')
				scripts.add(gate['script']);
	}
	return scripts;
}

/**
 * The package script a step runs, read as config.ts reads it: `bun run <script> ...`, the first
 * three words. Any other program runs no package script.
 */
function invokedScript(step: Pick<Step, 'run'>): null | string {
	const [program, verb, script] = step.run;
	return program === 'bun' && verb === 'run' && script !== undefined ? script : null;
}

/**
 * Refuses a fast gate that leaves out a qc step running a gate `manifestFile` marks fast, or
 * replaces it with other work. `skipped` gives the reason a step does not run in this repository,
 * or null: a step `onlyIn` skips here runs in no gate here, so the fast one need not hold it either.
 */
export function assertFastGates(
	config: { fast: null | Step[]; qc: Step[] },
	manifestFile: string,
	skipped: (step: Step) => null | string,
): void {
	const { fast, qc } = config;
	if (fast === null) return;
	const marked = fastGateScripts(manifestFile);
	for (const step of qc) {
		const script = invokedScript(step);
		if (script === null || !marked.has(script) || skipped(step) !== null) continue;
		// The fast gate must run this exact command, argument for argument: a different argument,
		// such as --root naming another tree, is a different check (Morticia L-1 on 8947c67), and
		// another qc step running the same script with other arguments does not cover this one
		// (Roger #61550). A fast.replace renames the step it stands in for, so the test is the
		// command, not the name, and only a fast step that runs here counts (Roger #61510).
		const command = JSON.stringify(step.run);
		if (fast.some((item) => JSON.stringify(item.run) === command && skipped(item) === null)) {
			continue;
		}
		fail(
			`qc step '${step.name}' runs ${script}, which ${manifestFile} marks fast, but no fast step ` +
				`runs ${command}. List the step in fast.steps; a fast.replace for it must run that ` +
				'same command.',
		);
	}
}
