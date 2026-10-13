/**
 * What `--check` does in a repository that owns no group: it checks itself against its own lock.
 *
 * It never sweeps the fleet. A repository's gate used to compare every sibling against the owner,
 * which made it red for files in other people's trees and, checked out alone, green having compared
 * nothing. Here the question is only about this tree: does it hold exactly what its
 * `smokestack.lock` says it was delivered.
 *
 * WHAT GREEN MEANS, and it is less than it looks. Alone, which is every CI run, the lock shows
 * that the files match the lock and nothing about where either came from: one commit that edits a
 * file and its hash passes. Nothing in a repository can enforce that only the owner's write touches
 * the lock. Where the owner is checked out beside this repository, origin.ts closes that by reading
 * the recorded commit; elsewhere the pass says so in a warning. And a repository may sit behind the
 * owner's newest tag and still pass.
 *
 * THE SET IS EXACT. For each group in the lock, the entries must be the synced files of that group:
 * none missing, none extra, and a file and its entry removed together is as red as either alone.
 * The set is read from tracked things only (expected.ts), so it is the same here whether or not
 * this clone dispatches the group's hook, and the same as the set the owner wrote the lock from.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { SharedCoreGroup } from './manifest.ts';

import { skipReason } from './eligibility.ts';
import { groupState, lockDifferences, syncedPaths } from './expected.ts';
import { type Lock, LOCK_FILE, LOCK_OWNER, readLock } from './lock.ts';
import { verifyOrigin } from './origin.ts';
import { discovers, readScripts } from './targets.ts';

interface Examined {
	files: number;
	/** One per defect, each `<path>:0 <message>`. */
	findings: string[];
}

function examine(root: string, manifest: SharedCoreGroup[], lock: Lock): Examined {
	const result: Examined = { files: 0, findings: [] };
	const byName = new Map(manifest.map((group) => [group.name, group]));
	const self = { directory: '.', path: root };
	const scripts = readScripts(root);

	for (const [name, recorded] of Object.entries(lock.groups)) {
		const group = byName.get(name);
		if (group === undefined) {
			result.findings.push(`${LOCK_FILE}:0 declares '${name}', which is not a group here`);
		} else if (recorded === null) {
			result.findings.push(`${LOCK_FILE}:0 declares '${name}' and records no delivery of it`);
		} else {
			result.files += Object.keys(recorded).length;
			// The comparison the owner's check makes of this same lock: expected.ts.
			for (const { path, problem } of lockDifferences(
				group,
				recorded,
				groupState(group, root),
			)) {
				result.findings.push(`${path}:0 ${problem}`);
			}
		}
	}

	for (const group of manifest.filter((candidate) => !(candidate.name in lock.groups))) {
		// The hook groups are installed into every repository they apply to. They are not opt-in,
		// so they are not this repository's to leave out of its lock.
		if (discovers(group, root) && skipReason(group, self, scripts) === null) {
			result.findings.push(
				`${LOCK_FILE}:0 does not record '${group.name}', which applies to this repository`,
			);
			continue;
		}
		// ANY synced path, not every one: dropping the declaration and one file must not pass.
		for (const { path } of syncedPaths(group)) {
			if (existsSync(join(root, path))) {
				result.findings.push(
					`${path}:0 is a synced file of '${group.name}', which the lock does not declare`,
				);
			}
		}
	}
	return result;
}

/**
 * Runs the self-check for the repository at `root` and prints its verdict. A lock that cannot be
 * read, or a git that cannot answer, is exit 2: nothing was learned about the repository.
 */
export function runSelfCheck(root: string, manifest: SharedCoreGroup[]): number {
	try {
		return selfCheck(root, manifest, readLock(root));
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		console.error(`[FAIL] Shared core self-check could not run: ${reason}`);
		return 2;
	}
}

function selfCheck(root: string, manifest: SharedCoreGroup[], lock: Lock | null): number {
	if (lock === null) {
		console.error(
			`[FAIL] This repository carries the shared-core sync and has no ${LOCK_FILE}, so ` +
				'nothing says what it takes and nothing was examined. Declare the groups it takes ' +
				`in a ${LOCK_FILE} and commit it.`,
		);
		return 1;
	}
	const groups = Object.keys(lock.groups).length;
	const { files, findings } = examine(root, manifest, lock);
	// A lock that names nothing, or names groups and holds no file, would pass over zero items.
	if (lock.version === undefined || files === 0) {
		const state = groups === 0 ? 'declares nothing' : 'records no delivered file';
		console.error(
			`[FAIL] ${LOCK_FILE} ${state}, so nothing was examined (0 file(s) in ${groups} ` +
				'group(s)). The owner writes the lock when it next delivers.',
		);
		return 1;
	}
	if (findings.length > 0) {
		for (const finding of findings) console.error(`- ${finding}`);
		console.error(
			`[FAIL] Shared core: this repository does not hold what its ${LOCK_FILE} records ` +
				`(${findings.length} finding(s); ${files} file(s) in ${groups} group(s) examined).`,
		);
		return 1;
	}

	const ownerRoot = join(dirname(root), LOCK_OWNER);
	const origin: ReturnType<typeof verifyOrigin> = existsSync(ownerRoot)
		? verifyOrigin(ownerRoot, lock)
		: {
				reason: `${LOCK_OWNER} is not checked out beside this repository`,
				state: 'unverified',
			};
	if (origin.state === 'forged') {
		for (const finding of origin.findings) console.error(`- ${finding}`);
		console.error(
			`[FAIL] Shared core: ${LOCK_FILE} is forged or mistaken. What it records is not ` +
				`what the ${LOCK_OWNER} beside this repository delivered as v${lock.version} ` +
				`(${origin.findings.length} finding(s)).`,
		);
		return 1;
	}
	if (origin.state === 'unverified') {
		console.warn(
			`[WARN] Origin not verified: ${origin.reason}. The files match the lock; whether the ` +
				`lock is what ${LOCK_OWNER} delivered was not checked.`,
		);
	} else if (origin.behind !== null) {
		console.warn(`[WARN] Behind: ${origin.behind}. Taking it is this repository's decision.`);
	}
	const verified = origin.state === 'verified' ? ', verified against that tag' : '';
	console.log(
		`[OK] Shared core: ${files} file(s) in ${groups} group(s) match ${LOCK_FILE} at ` +
			`${LOCK_OWNER} v${lock.version}${verified}.`,
	);
	return 0;
}
