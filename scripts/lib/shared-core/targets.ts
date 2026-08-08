/**
 * Resolves the repositories a group applies to.
 *
 * Two models, because the two existing syncs genuinely differ. The license core names its four
 * siblings in a gitignored roster; the hook installers sweep the fleet root and take whatever they
 * find. Neither can be expressed as the other: a roster cannot arm a repository nobody remembered
 * to add, and discovery cannot express a subset chosen by hand.
 *
 * A discovered group's marker is OPTIONAL, and each group's answer is copied from the installer it
 * replaced rather than chosen here. The history guard is installed into repositories carrying
 * `.aidd`, so its group names that marker. The leak guard is installed into every git repository
 * under the fleet root, so its groups name none. Giving both groups the `.aidd` marker is what made
 * the gate report thirty-two repositories current while the installer had covered fifty-one
 * (punchlist C5): a narrower predicate than the installer's does not report a smaller number, it
 * reports a complete-looking one.
 *
 * NO GROUP NAMES A TARGET REPOSITORY. This manifest is tracked in repositories that are published,
 * and a private sibling's name in a tracked file is the exact disclosure .githooks/leak-guard.sh
 * exists to stop. A roster group names a gitignored FILE; a discovered group names a MARKER.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SharedCoreGroup } from './manifest.ts';

export interface Target {
	/** Directory name beside the fleet root, used for reporting. */
	directory: string;
	/** Expected package.json "name", when the roster pins one. */
	packageName?: string;
	path: string;
}

function readRoster(ownerRoot: string, roster: string): null | string[] {
	const path = join(ownerRoot, roster);

	// Absent is not an error, and this is load-bearing rather than lenient. CI checks out one
	// repository, so there is nothing beside it to verify; an adopter of this template has no
	// siblings at all. Both must leave the gate green, or the gate gets removed from CI.
	if (!existsSync(path)) return null;
	const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
	if (!Array.isArray(parsed)) throw new Error(`${path}: expected an array of target entries.`);
	return parsed as string[];
}

function rosterTargets(group: SharedCoreGroup, fleetRoot: string, ownerRoot: string): Target[] {
	if (group.targets.model !== 'roster') return [];
	const entries = readRoster(ownerRoot, group.targets.roster);
	if (entries === null) return [];

	return entries.map((entry, index) => {
		const raw: Record<string, unknown> =
			typeof entry === 'string'
				? { directory: entry }
				: entry !== null && typeof entry === 'object'
					? (entry as Record<string, unknown>)
					: {};
		const directory = raw['directory'];
		const packageName = raw['packageName'] ?? directory;
		if (
			typeof directory !== 'string' ||
			directory.length === 0 ||
			directory !== directory.trim() ||
			directory === '.' ||
			directory === '..' ||
			/[\\/]/u.test(directory)
		) {
			throw new Error(
				`${group.targets.model === 'roster' ? group.targets.roster : ''}: entry ${index} ` +
					'directory must be one sibling directory name.',
			);
		}
		return {
			directory,
			path: join(fleetRoot, directory),
			...(typeof packageName === 'string' ? { packageName } : {}),
		};
	});
}

/**
 * Whether a repository already holds every file the group keeps current.
 *
 * `seeded` files are excluded deliberately: they are written once and never revisited, so their
 * presence says a repository was reached at some point, not that it is a carrier now. The synced
 * set is the one the group is responsible for, so it is the one that decides.
 */
function carriesGroup(group: SharedCoreGroup, repoPath: string): boolean {
	const synced = group.files.filter((file) => file.disposition === 'synced');

	// An empty set would make `every` vacuously true and select the whole fleet root.
	if (synced.length === 0) return false;
	return synced.every((file) =>
		existsSync(join(repoPath, group.targetRoot, file.target ?? file.source)),
	);
}

/** The file a repository writes to decline this fleet's shared tooling. */
const DECLINE_FILE = '.no-fleet-sync';

/**
 * The reason a repository declines, or null when it does not decline or is not allowed to.
 *
 * The inverse of the `.screenshot-capture` declaration (punchlist C7) and here for the same reason.
 * `common` was taken off the leak-guard rollout by an owner decision recorded only in prose, so every
 * discovered group went on classifying it `uncovered` — one of the two writable kinds — and a write
 * from a clean fleet kept offering to install three files into a repository that had been excluded on
 * purpose (punchlist S14). A decision no predicate can read is not an exclusion, it is a note.
 *
 * THE DECLARATION IS HONORED ONLY WHILE THE REPOSITORY HAS NO PUSH REMOTE, and that condition is what
 * makes the file safe to introduce at all. This subsystem exists because a token reached disk when
 * the leak guard was installed selectively; an unconditional opt-out would rebuild that hazard with
 * better ergonomics, one file per repository. Conditioned this way it can only ever exempt a
 * repository that cannot publish, and `git remote add` re-arms every group without anyone
 * remembering to come back here — the reasoning install-history-guard.ts already gives for installing
 * into repositories that have no remote today.
 *
 * A declining repository is SKIPPED WITH ITS REASON rather than dropped from discovery, because an
 * exclusion nobody sees is how this one lasted two days. Untracked is not rejected: it fails safe,
 * since a clone without the file is a clone that gets the guard.
 */
export function declineReason(repoPath: string): null | string {
	const path = join(repoPath, DECLINE_FILE);
	if (!existsSync(path)) return null;

	const remotes = Bun.spawnSync(['git', '-C', repoPath, 'remote', '-v'], {
		stderr: 'pipe',
		stdout: 'pipe',
		windowsHide: true,
	});
	const pushable = remotes.success && remotes.stdout.toString().includes('(push)');
	if (pushable) return null;

	const reason = readFileSync(path, 'utf8')
		.split('\n')
		.map((line) => line.trim())
		.find((line) => line.length > 0 && !line.startsWith('#'));
	return reason ?? `${DECLINE_FILE} is present but states no reason`;
}

function discoveredTargets(group: SharedCoreGroup, fleetRoot: string, owner: string): Target[] {
	if (group.targets.model !== 'discovered') return [];
	const { marker } = group.targets;

	return readdirSync(fleetRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.endsWith('.old'))
		.filter((entry) => entry.name !== owner)
		.map((entry) => ({ directory: entry.name, path: join(fleetRoot, entry.name) }))
		.filter(
			(t) =>
				existsSync(join(t.path, '.git')) &&
				(marker === undefined ||
					existsSync(join(t.path, marker)) ||
					// A repository that already carries the group is a target for UPDATES to it,
					// whatever the marker says. Two repositories held a two-week-old
					// screenshot-guard.sh for exactly this reason: they were seeded before the
					// `.aidd` marker described them, so every later fix routed around them and the
					// report called the group current (punchlist C1). A carrier the marker no
					// longer selects does not stop being a carrier; it stops being maintained.
					//
					// This is NOT the marker-names-the-guard design the manifest's `marker` doc
					// warns off, because it is a union arm rather than a replacement. The marker
					// still selects repositories that lack the files, so `uncovered` stays
					// reachable and the gate can still go red on a fleet missing the guard. This
					// arm only ever selects repositories where `uncovered` is already impossible,
					// so it widens maintenance without widening adoption.
					carriesGroup(group, t.path)),
		);
}

/**
 * `only` narrows the resolved set to the named directories and can never widen it: it is applied
 * after the model has answered, so a repository the roster omits or discovery rejects stays out
 * however it is spelled on the command line. That is what makes it safe as the rollout aid it is —
 * covering the fleet one repository at a time — rather than a second, looser way to name a target.
 */
export function resolveTargets(
	group: SharedCoreGroup,
	fleetRoot: string,
	ownerRoot: string,
	only?: Set<string>,
): Target[] {
	const targets =
		group.targets.model === 'roster'
			? rosterTargets(group, fleetRoot, ownerRoot)
			: discoveredTargets(group, fleetRoot, group.owner);
	return only === undefined ? targets : targets.filter((t) => only.has(t.directory));
}

/** Reads a target's package.json scripts. Returns null when the repository has no package.json. */
export function readScripts(repoPath: string): null | Record<string, string> {
	const path = join(repoPath, 'package.json');
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
			scripts?: Record<string, string>;
		};
		return parsed.scripts ?? {};
	} catch {
		return null;
	}
}
