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
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOTS_FILE = '.shared-core-roots.json';

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
