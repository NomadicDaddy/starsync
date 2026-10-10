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
 * Whether `command` runs what `required` runs. Either it contains the required command, or it
 * delegates to a script file that names the required command's final argument, the file actually
 * set up (summon's `bun scripts/setup-hooks.ts` runs `.githooks/leak-guard-setup.sh` itself).
 */
function runsSetup(repoPath: string, command: string, required: string): boolean {
	if (command.includes(required)) return true;
	const setup = required.trim().split(/\s+/u).at(-1) ?? required;
	return command.split(/\s+/u).some((token) => {
		if (!/\.(?:sh|ts)$/u.test(token)) return false;
		const path = join(repoPath, token);
		return existsSync(path) && readFileSync(path, 'utf8').includes(setup);
	});
}

/**
 * One `unwired` finding per required script the target does not run. Contains, not equals: see
 * SharedCoreGroup.wiring for why, and for what each value has to name so that a passing substring
 * is real evidence rather than a looser test. A target with no package.json has nothing to wire.
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
		if (script?.includes(required) === true) continue;
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
			kind: 'unwired',
			target: target.directory,
		});
	}
	return findings;
}
