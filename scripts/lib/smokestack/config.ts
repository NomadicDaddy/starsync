/**
 * `smokestack.json`: the one file a repository writes to say what its gate runs.
 *
 * It is the repository's own decision file. The sync never writes it and the lock does not hold
 * it. Everything the runner does is read from here, so everything wrong with it is refused before
 * any step starts: a gate that ran some steps and then met a mistyped key would have reported on a
 * gate nobody wrote.
 *
 * A step is a name and an argument list. Never a shell line: `&&`, pipes and quoting mean
 * different things to pwsh, cmd and bash, and every gate step in the fleet is `bun run <script>`
 * already. A step that needs more is a package script.
 *
 * The fast gate is a subset of the full gate by name, with named substitutions (a cached lint for
 * the full one, say). It cannot name a step the full gate does not run, so nothing can be checked
 * at commit time that the gate itself never checks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_FILE = 'smokestack.json';
const RUNNER_ENTRY = 'scripts/smokestack.ts';

/** The version this runner introduces. It also accepts the one before; see ACCEPTED_VERSIONS. */
const CONFIG_VERSION = 1;

/**
 * A delivery replaces the runner in a consumer at once, and the consumer's config changes only by
 * a commit there, through a hook this runner now runs. So a runner must read the version before
 * its own, or every consumer's gate and hook are dead between the delivery and that commit.
 */
const ACCEPTED_VERSIONS: readonly number[] = [CONFIG_VERSION];

export interface Step {
	description: string;
	name: string;
	run: string[];
}

export interface Config {
	fast: null | Step[];
	qc: Step[];
}

export class ConfigError extends Error {}

function fail(message: string): never {
	throw new ConfigError(`${CONFIG_FILE}: ${message}`);
}

function asObject(
	raw: unknown,
	where: string,
	allowed: readonly string[],
): Record<string, unknown> {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		fail(`${where} must be an object.`);
	}
	const object = raw as Record<string, unknown>;
	for (const key of Object.keys(object)) {
		if (!allowed.includes(key)) fail(`${where} has an unknown key '${key}'.`);
	}
	return object;
}

function asText(raw: unknown, where: string): string {
	if (typeof raw !== 'string' || raw.trim().length === 0) {
		fail(`${where} must be a non-empty string.`);
	}
	return raw;
}

function asRun(raw: unknown, where: string): string[] {
	if (!Array.isArray(raw) || raw.length === 0) fail(`${where} must be a non-empty list.`);
	return raw.map((item, index) => asText(item, `${where}[${index}]`));
}

/** Whether running the package script `name` reaches the runner, through any number of scripts. */
function reachesRunner(name: string, scripts: Record<string, string>, seen: Set<string>): boolean {
	const body = scripts[name];
	if (body === undefined || seen.has(name)) return false;
	seen.add(name);
	if (body.includes(RUNNER_ENTRY)) return true;
	return [...body.matchAll(/\bbun run ([\w:.-]+)/gu)].some(([, next]) =>
		reachesRunner(next as string, scripts, seen),
	);
}

/**
 * `bun run <script>` must name a script the repository defines, known before the chain reaches it.
 * And no step may run the gate: it would start the gate inside itself, without end. That is
 * refused whether the step starts the runner's file itself or reaches it through package scripts.
 */
function assertScriptExists(step: Step, scripts: null | Record<string, string>): void {
	if (step.run.some((part) => part.replaceAll('\\', '/').endsWith(RUNNER_ENTRY))) {
		fail(`step '${step.name}' runs ${RUNNER_ENTRY}, which is the gate itself.`);
	}
	const [program, verb, script] = step.run;
	if (program !== 'bun' || verb !== 'run' || script === undefined) return;
	if (scripts === null || !(script in scripts)) {
		fail(`step '${step.name}' runs '${script}', which is not a script in package.json.`);
	}
	if (reachesRunner(script, scripts, new Set())) {
		fail(`step '${step.name}' runs '${script}', which is the gate itself.`);
	}
}

function asSteps(raw: unknown, scripts: null | Record<string, string>): Step[] {
	const qc = asObject(raw, 'qc', ['steps']);
	const list = qc['steps'];
	if (!Array.isArray(list) || list.length === 0) fail('qc.steps must be a non-empty list.');
	const seen = new Set<string>();
	return list.map((item, index) => {
		const where = `qc.steps[${index}]`;
		const object = asObject(item, where, ['description', 'name', 'run']);
		const step: Step = {
			description: asText(object['description'], `${where}.description`),
			name: asText(object['name'], `${where}.name`),
			run: asRun(object['run'], `${where}.run`),
		};
		if (seen.has(step.name)) fail(`two steps are named '${step.name}'.`);
		seen.add(step.name);
		assertScriptExists(step, scripts);
		return step;
	});
}

function asReplacements(
	raw: unknown,
	fastNames: string[],
	scripts: null | Record<string, string>,
): Map<string, Pick<Step, 'name' | 'run'>> {
	const replacements = new Map<string, Pick<Step, 'name' | 'run'>>();
	if (raw === undefined) return replacements;
	const object = asObject(raw, 'fast.replace', fastNames);
	for (const [replaced, value] of Object.entries(object)) {
		const where = `fast.replace.${replaced}`;
		const entry = asObject(value, where, ['name', 'run']);
		const replacement = {
			name: asText(entry['name'], `${where}.name`),
			run: asRun(entry['run'], `${where}.run`),
		};
		assertScriptExists({ ...replacement, description: '' }, scripts);
		replacements.set(replaced, replacement);
	}
	return replacements;
}

function asFast(raw: unknown, qc: Step[], scripts: null | Record<string, string>): null | Step[] {
	if (raw === undefined) return null;
	const fast = asObject(raw, 'fast', ['replace', 'steps']);
	const list = fast['steps'];
	if (!Array.isArray(list) || list.length === 0) fail('fast.steps must be a non-empty list.');
	const names = list.map((item, index) => asText(item, `fast.steps[${index}]`));
	if (new Set(names).size !== names.length) fail('fast.steps names a step twice.');
	const byName = new Map(qc.map((step) => [step.name, step]));
	for (const name of names) {
		if (!byName.has(name)) fail(`fast step '${name}' is not a qc step.`);
	}
	// asObject's allow-list is the fast step names, so a replacement for anything else is refused.
	const replacements = asReplacements(fast['replace'], names, scripts);
	const steps = names.map((name) => {
		const full = byName.get(name) as Step;
		const replacement = replacements.get(name);
		return replacement === undefined ? full : { ...full, ...replacement };
	});
	if (new Set(steps.map((step) => step.name)).size !== steps.length) {
		fail('fast.replace gives two fast steps one name.');
	}
	return steps;
}

/** Parses and validates the text of a config. `scripts` is the repository's package.json scripts. */
export function parseConfig(text: string, scripts: null | Record<string, string>): Config {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		fail(`is not JSON (${err instanceof Error ? err.message : String(err)}).`);
	}
	const root = asObject(raw, 'the file', ['fast', 'qc', 'version']);
	const version = root['version'];
	if (typeof version !== 'number' || !ACCEPTED_VERSIONS.includes(version)) {
		fail(
			`version ${JSON.stringify(version)} is not one this runner reads ` +
				`(${ACCEPTED_VERSIONS.join(', ')}).`,
		);
	}
	const qc = asSteps(root['qc'], scripts);
	return { fast: asFast(root['fast'], qc, scripts), qc };
}

/** Reads the config at `root`. A missing file is a ConfigError: nothing says what the gate is. */
export function readConfig(root: string, scripts: null | Record<string, string>): Config {
	let text: string;
	try {
		text = readFileSync(join(root, CONFIG_FILE), 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
		fail(`is missing at ${root}, so nothing says what this repository's gate runs.`);
	}
	return parseConfig(text, scripts);
}
