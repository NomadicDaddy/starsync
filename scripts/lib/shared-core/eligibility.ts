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
 */
import { existsSync, readFileSync } from 'node:fs';
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
	if (group.requiresPackageJson === true && scripts === null) return 'no package.json';
	return null;
}

/**
 * Throws when a roster entry pins a package name the directory does not hold.
 *
 * A roster names DIRECTORIES, and a directory is not an identity: a rename, a stale entry, or a
 * clone under a different name would silently retarget a write at whatever sits there now. This is
 * fatal rather than a skip because it means the roster is wrong, and continuing would compare the
 * right files against the wrong repository.
 */
export function assertPackageIdentity(target: Target): void {
	if (target.packageName === undefined) return;
	const manifest = join(target.path, 'package.json');
	if (!existsSync(manifest)) return;

	const name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name;
	if (name !== target.packageName) {
		throw new Error(
			`${target.directory}: expected package ${target.packageName}, found ${name ?? 'none'}.`,
		);
	}
}
