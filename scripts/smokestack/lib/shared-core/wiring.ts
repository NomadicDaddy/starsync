/**
 * Whether a target's package.json wires the scripts a group needs.
 *
 * Split out of check.ts, which compares files and reads hook dispatch; this reads package.json and,
 * for explicit setup, the script file a command names.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Finding } from './check.ts';
import type { SharedCoreGroup } from './manifest.ts';
import type { Target } from './targets.ts';

/**
 * Explicit contributor setup that stands in for an automatic `prepare`. summon wires its hooks
 * through `setup:hooks` on purpose (Morgan #7916): a clone is armed by a deliberate step rather than
 * by every install, and reporting that as UNWIRED pressures it toward a design it rejected. It
 * counts only when it runs the same setup, which runsSetup checks rather than trusting the name.
 */
const EXPLICIT_SETUP: Record<string, string> = { prepare: 'setup:hooks' };

/**
 * A command step that begins by running a script file, capturing the file. Anchored at the start
 * on purpose: `echo bun scripts/setup.ts` names a runner and a script and executes neither.
 */
const RUNS_SCRIPT = /^(?:bun(?:\s+run)?|node|tsx|bash|sh)\s+(\S+\.(?:sh|ts))(?:\s|$)/u;

/**
 * A script's code with its comments removed, so that a setup file named only in a comment, or in
 * documentation that outlived the call it describes, cannot pass for one the script runs.
 */
function codeOf(path: string): string {
	const text = readFileSync(path, 'utf8');
	if (path.endsWith('.sh')) return text.replaceAll(/^\s*#.*$/gmu, '');
	return text.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/(^|\s)\/\/.*$/gmu, '$1');
}

/**
 * Whether `command` runs what `required` runs, judged one step at a time and by how each step
 * begins. A step counts when it begins with the required command, or begins with a runner
 * executing a script file whose code (not its comments) names the required command's final
 * argument, the file actually set up. summon's `bun scripts/setup-hooks.ts` passes
 * `.githooks/leak-guard-setup.sh` to its runner itself. Any other form stays unproven, and an
 * unproven setup is reported as UNWIRED rather than assumed (Roger's dab78ef and 7afa482 reviews).
 */
function runsSetup(repoPath: string, command: string, required: string): boolean {
	const setup = required.trim().split(/\s+/u).at(-1) ?? required;
	const steps = command.split(/&&|\|\||;/u).map((step) => step.trim());
	return steps.some((step) => {
		if (step.startsWith(required)) return true;
		const script = RUNS_SCRIPT.exec(step)?.[1];
		if (script === undefined) return false;
		const path = join(repoPath, script);
		return existsSync(path) && codeOf(path).includes(setup);
	});
}

/** Whether the target has any file the group delivers. */
function holdsGroup(group: SharedCoreGroup, target: Target): boolean {
	return group.files.some((file) =>
		existsSync(join(target.path, group.targetRoot, file.target ?? file.source)),
	);
}

/**
 * One `unwired` finding per required script the target does not run. Contains, not equals: see
 * SharedCoreGroup.wiring for why, and for what each value has to name so that a passing substring
 * is real evidence rather than a looser test. A target with no package.json has nothing to wire.
 * A group whose wiring is required is held to equality instead, and reported as `not-run`.
 */
export function wiringFindings(
	group: SharedCoreGroup,
	target: Target,
	scripts: null | Record<string, string>,
): Finding[] {
	if (scripts === null) return [];
	const findings: Finding[] = [];
	for (const [key, required] of Object.entries(group.wiring ?? {})) {
		const script = scripts[key];
		// Where the wiring is the group's point, the script must BE the command. Containing it is
		// not running it: `<command> --list` and `echo <command>` both contain it and run nothing.
		const wired =
			group.wiringRequired === true
				? script?.trim() === required
				: script?.includes(required) === true;
		if (wired) continue;
		const alternative = EXPLICIT_SETUP[key];
		const explicit = alternative === undefined ? undefined : scripts[alternative];
		if (
			script === undefined &&
			explicit !== undefined &&
			runsSetup(target.path, explicit, required)
		) {
			continue;
		}
		findings.push({
			detail: `package.json script '${key}' ${script === undefined ? 'is missing' : `does not run \`${required}\``}`,
			group: group.name,
			// Holding the files is what makes it a failure: before a delivery there is nothing to run.
			kind:
				group.wiringRequired === true && holdsGroup(group, target) ? 'not-run' : 'unwired',
			target: target.directory,
		});
	}
	return findings;
}
