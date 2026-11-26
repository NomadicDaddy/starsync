/**
 * Retiring a group from a repository: `--retire <group>` on a write narrowed with `--only`.
 *
 * A lock that declares a group which no longer reaches its repository stops the whole write
 * (lock-plan.ts), because rewriting the lock would silently drop what that repository declared.
 * That refusal is right for a mistake. It also left no way to take a group away on purpose: the
 * delivered files stayed, with no consumer, and every later write to that repository was refused.
 *
 * So a departure is said twice, and nothing here infers it. The record forgets the group there
 * first (`bun run deliveries:forget <directory> --group <name>`), the command that acknowledges
 * any departure, and the write is then told to retire it. Only then does a write remove the
 * group's files from that repository and leave the group out of the lock it rewrites. A declared
 * group is retired while the repository's committed lock still declares it, so the hashes it
 * records are there to prove each file untouched; the write stops counting it as reaching the
 * named repositories (lock-plan.ts) rather than waiting for the declaration to go first.
 *
 * A file is removed only while it is exactly what the lock says was delivered, with no
 * uncommitted change: a file the repository has edited is its own work, and the write refuses
 * rather than destroy it. A hook kept by hand, recorded as a claim and not a hash, is refused for
 * the same reason. The removals happen only where the lock is rewritten, so a withheld lock never
 * names a group whose files are gone. The repository's lead commits the removal, and is told so.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { DeliveredTarget } from './deliveries.ts';

import { hashShared, isClaim, type Lock, LOCK_FILE, type LockedFile } from './lock.ts';
import { hasUncommittedChanges } from './write.ts';

/**
 * The mode the index holds for `installed` in the repository at `root`, or undefined where git
 * tracks no such path. Not expected.ts's gitModes: that answers for an untracked path too, with
 * the mode `git add` would record, which is right for a file about to be delivered and wrong for
 * one about to be removed.
 */
function trackedMode(root: string, installed: string): string | undefined {
	const listed = Bun.spawnSync(['git', '-C', root, 'ls-files', '-s', '-z', '--', installed], {
		stderr: 'pipe',
		stdout: 'pipe',
		windowsHide: true,
	});
	if (listed.exitCode !== 0) {
		const detail = listed.stderr.toString().trim();
		throw new Error(`git could not list ${installed} in ${root}.${detail ? ` ${detail}` : ''}`);
	}
	const record = listed.stdout.toString().split('\0')[0] ?? '';
	const tab = record.indexOf('\t');
	return tab === -1 || record.slice(tab + 1) !== installed ? undefined : record.slice(0, 6);
}

/**
 * One group leaving one repository, or a group dropping files it delivered to a repository it still
 * reaches: the installed paths the write removes, relative to it.
 */
export interface Retirement {
	directory: string;
	/** True when the group still reaches the repository and only these files left it. */
	dropped: boolean;
	files: string[];
	group: string;
}

/**
 * Why the delivered copy at `installed` cannot be removed, or null when it can. A copy that is not
 * there needs no removal and is left to the caller.
 */
function removalBlocker(path: string, installed: string, locked: LockedFile): null | string {
	if (isClaim(locked)) return `${installed} is a hook kept as a ${locked.claim}, not the owner's`;
	// Uncommitted work first: a mode staged or changed on disk is work in progress there. Then the
	// file has to be tracked, with the committed mode the lock records. A file untracked and ignored
	// is clean to git status, but its delivered state is gone and git history no longer holds what a
	// removal would delete.
	const mode = trackedMode(path, installed);
	if (hashShared(join(path, installed)) !== locked.sha256)
		return `${installed} differs from what was delivered`;
	if (hasUncommittedChanges(path, installed)) return `${installed} has uncommitted changes`;
	if (mode === undefined) return `${installed} is not tracked there`;
	if (mode !== locked.mode) return `${installed} is committed as ${mode}, not ${locked.mode}`;
	return null;
}

interface RetirementPlan {
	refusals: string[];
	retired: Retirement[];
	/** Declared groups that do not reach the repository and were not asked to retire. */
	unreached: string[];
}

/** One repository with a lock, as the write's plan sees it. */
export interface LockedRepository {
	/** Groups its lock declares that no group reaching it from here delivers. */
	declared: string[];
	directory: string;
	/** What the record holds for it. */
	entry: DeliveredTarget | undefined;
	/** Every installed path a group still reaching it installs there. */
	installs: Set<string>;
	lock: Lock;
	path: string;
}

/**
 * Splits the groups a repository's lock declares and nothing delivers there into those this write
 * retires and those it still has to refuse.
 *
 * A path a group still reaching the repository installs is never removed, whichever group the lock
 * last filed it under: a file that moved from the retiring group into one the repository keeps is
 * written there by this same run, and removing it afterwards would undo that delivery.
 */
export function planRetirements(
	repository: LockedRepository,
	retiring: Set<string>,
): RetirementPlan {
	const { declared, directory, entry, installs, lock, path } = repository;
	const plan: RetirementPlan = { refusals: [], retired: [], unreached: [] };
	for (const group of declared) {
		if (!retiring.has(group)) {
			plan.unreached.push(group);
			continue;
		}
		if (entry?.groups[group] !== undefined) {
			plan.refusals.push(
				`${directory}: --retire ${group} needs the departure acknowledged first, and the ` +
					`record still holds it there: bun run deliveries:forget ${directory} --group ${group}`,
			);
			continue;
		}
		const unfit: string[] = [];
		const files: string[] = [];
		for (const [installed, locked] of Object.entries(lock.groups[group] ?? {})) {
			if (installs.has(installed)) continue;
			if (!isClaim(locked) && !existsSync(join(path, installed))) continue;
			const blocker = removalBlocker(path, installed, locked);
			if (blocker === null) files.push(installed);
			else unfit.push(blocker);
		}
		if (unfit.length > 0) {
			plan.refusals.push(
				`${directory}: --retire ${group} would remove that repository's own work ` +
					`(${unfit.join('; ')}). Nothing was removed. Settle it there and run again.`,
			);
			continue;
		}
		plan.retired.push({ directory, dropped: false, files, group });
	}
	return plan;
}

/**
 * The files a group still reaching the repository recorded there and no longer installs: a file
 * taken out of the group in the manifest (shared-core-write-removes-files-a-reaching-group-drops).
 * The rewritten lock stops naming such a file, so a copy left on disk would be one no lock or sweep
 * sees. It goes under the rules a retirement keeps, and the manifest change is the decision: unlike
 * a group leaving, the repository still takes the group, so there is no departure to acknowledge.
 *
 * `reaching` names the groups still reaching it, and `moving` every recorded path move.ts moves to
 * a new home. A path another reaching group installs is that group's now, and is kept.
 */
export function planDropped(
	repository: LockedRepository,
	reaching: string[],
	moving: Set<string>,
): { refusals: string[]; retired: Retirement[] } {
	const { directory, installs, lock, path } = repository;
	const plan: { refusals: string[]; retired: Retirement[] } = { refusals: [], retired: [] };
	for (const group of reaching) {
		const unfit: string[] = [];
		const files: string[] = [];
		for (const [installed, locked] of Object.entries(lock.groups[group] ?? {})) {
			if (installs.has(installed) || moving.has(installed)) continue;
			if (!isClaim(locked) && !existsSync(join(path, installed))) continue;
			const blocker = removalBlocker(path, installed, locked);
			if (blocker === null) files.push(installed);
			else unfit.push(blocker);
		}
		if (unfit.length > 0) {
			plan.refusals.push(
				`${directory}: ${group} no longer delivers what its ${LOCK_FILE} records there, and ` +
					`removing it would remove that repository's own work (${unfit.join('; ')}). ` +
					'Nothing was removed. Settle it there and run again.',
			);
		} else if (files.length > 0) {
			plan.retired.push({ directory, dropped: true, files, group });
		}
	}
	return plan;
}

/**
 * Each --retire group no planned repository retires: a flag that did nothing must not pass.
 *
 * A write plans only the repositories some group reaches. A repository with a lock is always
 * reached, by the discovered groups if nothing else, so this is a repository that declines the
 * fleet or whose lock is gone, or a group its committed lock does not declare (any more): this
 * write does not open that lock, or finds no hashes in it to prove a removal by. The refusal says
 * so rather than guess.
 */
export function idleRetirements(retiring: Set<string>, retired: Retirement[]): string[] {
	const acted = new Set(retired.map((retirement) => retirement.group));
	return [...retiring]
		.filter((group) => !acted.has(group))
		.map(
			(group) =>
				`--retire ${group}: no repository this run rewrites a ${LOCK_FILE} for declares it, ` +
				'so there is nothing to retire. A repository that declines the fleet or has no ' +
				'lock is not reached at all, so a write retires nothing there: its lead removes ' +
				`the delivered files and the ${LOCK_FILE} there, and the record forgets the ` +
				'repository.',
		);
}

/**
 * Removes the files of every retirement whose repository's lock was rewritten, and returns the
 * lines that report it. `held` names the repositories whose lock was withheld; theirs stay.
 */
export function applyRetirements(
	retired: Retirement[],
	held: Set<string>,
	fleetRoot: string,
	dryRun: boolean,
): string[] {
	const lines: string[] = [];
	for (const { directory, dropped, files, group } of retired) {
		if (held.has(directory)) continue;
		const verb = dryRun ? 'WOULD REMOVE' : 'REMOVED';
		const why = dropped ? `${group} no longer delivers it` : `${group} retired`;
		for (const installed of files) {
			if (!dryRun) rmSync(join(fleetRoot, directory, installed));
			lines.push(`  ${verb} ${directory}: ${installed} (${why})`);
		}
		const named = files.length > 0 ? files.join(', ') : 'it';
		const what = dropped
			? `${group} no longer delivers ${named} there`
			: `${group} is retired there`;
		// A retire changes which groups the lock declares, and membership moves only once that is
		// committed (membership.ts): until then the sweep and every unnarrowed write stop on it.
		const until = dropped
			? ''
			: ` Until then it reads as UNREADABLE-MEMBERSHIP, and a write that is not narrowed ` +
				`with --only to leave ${directory} out is refused.`;
		lines.push(
			`LEAD ${directory}: ${what}. Commit the removal and the new ${LOCK_FILE}, and drop any ` +
				`reference to ${named}.${until}`,
		);
	}
	return lines;
}
