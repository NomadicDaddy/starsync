/**
 * Whether a resolved target is one this run may compare at all, and why not when it is not.
 *
 * Separate from check.ts because it answers a different question in a different vocabulary. That
 * file classifies FILES against their owner; this one admits or excludes a REPOSITORY before any
 * file is read, and every exclusion here has to come back with a sentence a person can act on.
 *
 * An excluded repository is skipped WITH ITS REASON rather than dropped, and that is the whole point
 * of the split. A target that quietly disappears from a run reads exactly like a target that passed:
 * `common` sat excluded-in-prose and reported `uncovered` for two days (punchlist S14), and eleven
 * repositories once read as current because a narrower predicate returned a complete-looking number
 * rather than a smaller one (punchlist C5).
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { SharedCoreGroup } from './manifest.ts';
import type { Target } from './targets.ts';

import { declineReason } from './targets.ts';

/**
 * The reason this target is not compared, or null when it is.
 *
 * Order is deliberate. A repository states its own position before anything else is read about it,
 * so a decline is reported as a decline rather than as whichever incidental property — an absent
 * package.json, an unset hooks path — happens to be noticed first.
 */
export function skipReason(
	group: SharedCoreGroup,
	target: Target,
	scripts: null | Record<string, string>,
): null | string {
	if (!existsSync(target.path)) return 'not checked out';

	const declined = declineReason(target.path);
	if (declined !== null) return `declines: ${declined}`;
	if (scripts === null) {
		// readScripts gives null for both, and they want different fixes.
		const present = existsSync(join(target.path, 'package.json'));
		if (group.requiresPackageJson === true) {
			return present ? 'package.json is not valid JSON' : 'no package.json';
		}
		// A group whose package.json needs are per file still takes its other files where there is
		// no package.json at all (check.ts leaves the flagged ones out). A broken one is not "none":
		// the wiring could not be read, so the repository is told to fix it, as before.
		if (present && group.files.some((file) => file.requiresPackageJson)) {
			return 'package.json is not valid JSON';
		}
	}
	return null;
}
