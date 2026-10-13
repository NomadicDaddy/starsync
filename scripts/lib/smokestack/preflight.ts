/**
 * The check made before the first step: does this repository hold what its lock records.
 *
 * It is here, and not only a step in the config, because the config is the repository's own. A
 * repository could drop the shared-files step and then edit a delivered gate, the runner included,
 * unseen by its own gate. Run from here it cannot be configured away.
 *
 * WHAT IT PROVES, which is less than it may look. It finds a delivered file that differs from the
 * lock while the runner and the checker are themselves intact. Someone who edits either can make
 * it skip or lie, and a file and its lock entry edited together in a clone with no owner beside it
 * pass, which is the limit the lock already states. The owner's sweep is the second look.
 *
 * Two kinds of result. A run that cannot be trusted at all is refused before any step: no lock, a
 * lock that cannot be read, a lock that does not declare the runner or what the runner requires.
 * A file that differs is a failed first step: the full gate goes on and runs everything else, so
 * one drifted file does not hide the test results, and the fast gate stops there.
 *
 * A group the lock declares with nothing delivered fails the full gate and not the fast one. The
 * fast gate runs for the commit in front of it, and that commit is how a group is asked for: the
 * owner will not deliver over an uncommitted lock.
 *
 * Only the owner skips the check, and being the owner takes all three of: the package is named
 * for it, the manifest names it owner of a group, and there is no lock at the root. A consumer
 * that renames its package still has its lock, and cannot delete it without the owner's sweep
 * reporting a delivery whose lock is gone.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Mode, Preflight } from './gate.ts';

import { LOCK_FILE, LOCK_OWNER, readLock } from '../shared-core/lock.ts';
import { loadManifest } from '../shared-core/manifest.ts';
import { verifyOrigin } from '../shared-core/origin.ts';
import { examine } from '../shared-core/self-check.ts';
import { repoIdentity } from '../shared-core/write.ts';

const RUNNER_GROUP = 'runner';
const STEP_NAME = 'shared files';

export type Standing =
	| { preflight: null | Preflight; state: 'ready'; version: string }
	| { reason: string; state: 'refused' };

/** The owner has no lock to name a version, so it reads its own package file. */
function ownerVersion(root: string): string {
	try {
		const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
			version?: string;
		};
		return parsed.version ?? 'unversioned';
	} catch {
		return 'unversioned';
	}
}

/** Decides whether the gate may start in `root`, and makes the check that runs before step one. */
export function standing(root: string, mode: Mode): Standing {
	const manifest = loadManifest(join(root, 'scripts'));
	const lockPresent = existsSync(join(root, LOCK_FILE));
	const identity = repoIdentity(root);
	const ownsAGroup = manifest.some((group) => group.owner === identity);
	if (identity === LOCK_OWNER && ownsAGroup && !lockPresent) {
		return { preflight: null, state: 'ready', version: ownerVersion(root) };
	}

	const lock = readLock(root);
	if (lock === null) {
		return {
			reason: `there is no ${LOCK_FILE} here, so nothing says what this repository was delivered`,
			state: 'refused',
		};
	}
	const runner = manifest.find((group) => group.name === RUNNER_GROUP);
	const needed = [RUNNER_GROUP, ...(runner?.requires ?? [])];
	const undeclared = needed.filter((name) => !(name in lock.groups));
	if (runner === undefined || undeclared.length > 0) {
		const what = runner === undefined ? `'${RUNNER_GROUP}' is not a group here` : undeclared;
		return {
			reason:
				`${LOCK_FILE} does not declare what this runner needs to check itself ` +
				`(${Array.isArray(what) ? what.join(', ') : what})`,
			state: 'refused',
		};
	}

	const examined = examine(root, manifest, lock);
	const lines = examined.findings.map((finding) => `- ${finding}`);
	// The drift is every finding that is not a bare declaration.
	let failed = examined.findings.length > examined.undelivered.length || examined.files === 0;
	if (examined.files === 0) lines.push(`- ${LOCK_FILE}:0 records no delivered file`);
	if (mode === 'qc' && examined.undelivered.length > 0) failed = true;
	if (mode === 'fast' && examined.undelivered.length > 0) {
		lines.push(
			`declared and not yet delivered: ${examined.undelivered.join(', ')}. This commit may ` +
				'go ahead; the full gate fails until the owner delivers.',
		);
	}

	const ownerRoot = join(dirname(root), LOCK_OWNER);
	if (!failed && lock.version !== undefined && existsSync(ownerRoot)) {
		const origin = verifyOrigin(ownerRoot, lock);
		if (origin.state === 'forged') {
			failed = true;
			lines.push(...origin.findings.map((finding) => `- ${finding}`));
		} else if (origin.state === 'unverified') {
			lines.push(`[WARN] origin not verified: ${origin.reason}`);
		} else if (origin.behind !== null) {
			lines.push(`[WARN] behind: ${origin.behind}`);
		}
	} else if (!failed) {
		// The files match the lock; whether the lock is what the owner delivered was not checked.
		lines.push(`[WARN] origin not verified: ${LOCK_OWNER} is not checked out beside this one`);
	}
	lines.push(
		`${examined.files} file(s) in ${Object.keys(lock.groups).length} group(s) held against ${LOCK_FILE}`,
	);
	return {
		preflight: { lines, name: STEP_NAME, passed: !failed },
		state: 'ready',
		version: lock.version ?? 'undelivered',
	};
}
