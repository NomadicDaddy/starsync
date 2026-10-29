/**
 * The repo-holding roots a fleet sweep deliberately leaves out, and why.
 *
 * Phillip's #8053 rule: a scanner covers every repo-holding root or says which it skipped and why.
 * Applications live under the fleet root alone (#8070), and the guards are for applications
 * (#8066), so the sweep stays where it was; what it lacked was saying so. Which other roots exist is
 * a fact about the machine, not about this template, so the list lives in an untracked file beside
 * the repositories rather than in the manifest, which is tracked in published repositories.
 *
 * Absent is not an error, for the reason the roster gives: CI and an adopter of this template have
 * no such file, and the gate has to stay green there. The output then says no other root was
 * considered, so the absence is stated rather than mistaken for coverage.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const ROOTS_FILE = '.shared-core-roots.json';
export const FLEET_ROOT_ENV = 'SMOKESTACK_FLEET_ROOT';

/**
 * Where the owner's untracked configuration lives: the rosters and the record of deliveries. Both
 * are gitignored because they name private sibling repositories, so a linked git worktree of the
 * owner (the team puts every branch in one) has neither. Run from such a worktree, they are read
 * from the main checkout the worktree belongs to; anywhere else, from the checkout itself.
 */
export function configRoot(ownerRoot: string): string {
	const dotGit = join(ownerRoot, '.git');
	let text: string;
	try {
		if (!statSync(dotGit).isFile()) return ownerRoot;
		text = readFileSync(dotGit, 'utf8');
	} catch {
		return ownerRoot;
	}
	const gitDir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
	if (!gitDir) return ownerRoot;
	const absolute = resolve(ownerRoot, gitDir);
	const marker = absolute.replaceAll('\\', '/').lastIndexOf('/.git/worktrees/');
	return marker < 0 ? ownerRoot : absolute.slice(0, marker);
}

/**
 * The directory holding the peer repositories when no --fleet-root is given: SMOKESTACK_FLEET_ROOT
 * when set, otherwise the parent of the main checkout, which from a worktree is not the worktree's
 * own parent.
 */
export function defaultFleetRoot(ownerRoot: string, env: NodeJS.ProcessEnv = process.env): string {
	const fromEnv = env[FLEET_ROOT_ENV];
	if (fromEnv) return resolve(fromEnv);
	return dirname(configRoot(ownerRoot));
}

export interface SkippedRoot {
	path: string;
	reason: string;
}

export interface FleetRoots {
	/** The file the list came from, or null when the fleet root has none. */
	file: null | string;
	skip: SkippedRoot[];
}

export function loadFleetRoots(fleetRoot: string): FleetRoots {
	const file = join(fleetRoot, ROOTS_FILE);
	if (!existsSync(file)) return { file: null, skip: [] };

	const fail = (message: string): never => {
		throw new Error(`${file}: ${message}`);
	};
	const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return fail('expected an object with a "skip" map.');
	}
	// Any other key is refused rather than ignored: a "scan" entry here would read as a root being
	// swept when nothing sweeps it.
	const unknown = Object.keys(parsed).filter((key) => key !== 'skip');
	if (unknown.length > 0) fail(`unsupported key(s): ${unknown.join(', ')}.`);
	const { skip = {} } = parsed as { skip?: unknown };
	if (skip === null || typeof skip !== 'object' || Array.isArray(skip)) {
		return fail('"skip" must map each directory path to the reason it is skipped.');
	}

	const skipped = Object.entries(skip as Record<string, unknown>).map(([path, reason]) => {
		// A skip with no reason is the silent exclusion the rule exists to stop.
		if (typeof reason !== 'string' || !reason.trim()) {
			return fail(`"skip" entry ${path} must state why it is skipped.`);
		}
		return { path: resolve(fleetRoot, path), reason: reason.trim() };
	});
	return { file, skip: skipped };
}

/** One line naming the root swept and every root skipped, so the output states its coverage. */
export function describeRoots(fleetRoot: string, roots: FleetRoots): string {
	if (roots.file === null) {
		return `Roots: scanned ${fleetRoot}. No ${ROOTS_FILE} there, so no other root was considered.`;
	}
	const skipped = roots.skip.map((s) => `${s.path} (${s.reason})`).join(', ') || 'none';
	return `Roots: scanned ${fleetRoot}; skipped ${skipped}. From ${roots.file}.`;
}
