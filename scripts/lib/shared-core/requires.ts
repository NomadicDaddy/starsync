/**
 * A group that cannot work without another.
 *
 * The runner checks a repository against its lock before it runs a step, with the checker the sync
 * tool's group delivers. A repository holding the runner and not the checker has a gate that
 * cannot make its first check. Copying the checker into the runner's group would put one file in
 * two groups, so the dependency is said once, in the manifest, and held in three places: the
 * owner's write refuses to deliver a group without what it requires, the owner's sweep reports a
 * lock that declares one without the other, and a repository's own check fails the same state.
 *
 * All three ask this file, so they cannot disagree about what "without" means: the requirement is
 * met by a set of group names, whatever that set is in the place asking (the groups a lock
 * declares, or the groups that reach a repository).
 */
import type { SharedCoreGroup } from './manifest.ts';

/** Reads a group's `requires` from the manifest's raw JSON. Throws on anything but a name list. */
export function asRequires(raw: unknown, where: string): string[] {
	if (raw === undefined) return [];
	const valid =
		Array.isArray(raw) &&
		raw.length > 0 &&
		raw.every((name) => typeof name === 'string' && name.length > 0);
	if (!valid) {
		throw new Error(
			`shared-core-manifest.json: ${where} requires must be a non-empty list of group names.`,
		);
	}
	return [...new Set(raw as string[])].sort();
}

/** A requirement must name a group that exists and is not the group itself. */
export function assertRequirements(groups: SharedCoreGroup[]): void {
	const names = new Set(groups.map((group) => group.name));
	for (const group of groups) {
		for (const required of group.requires ?? []) {
			if (required === group.name || !names.has(required)) {
				throw new Error(
					`shared-core-manifest.json: group '${group.name}' requires '${required}', ` +
						'which is not another group in this manifest.',
				);
			}
		}
	}
}

export interface Unmet {
	group: string;
	required: string;
}

/**
 * Every requirement that `held` does not meet. `held` is the set of group names present where the
 * question is asked. Groups outside the manifest are not this function's to report.
 */
export function unmetRequirements(manifest: SharedCoreGroup[], held: Iterable<string>): Unmet[] {
	const present = new Set(held);
	const unmet: Unmet[] = [];
	for (const group of manifest) {
		if (!present.has(group.name)) continue;
		for (const required of group.requires ?? []) {
			if (!present.has(required)) unmet.push({ group: group.name, required });
		}
	}
	return unmet;
}

/** What the write says of a group that reaches a repository without what it requires. */
export function describeUnmet(unmet: Unmet): string {
	return `'${unmet.group}' requires '${unmet.required}'`;
}

/** What both checks say of a lock that declares a group without what it requires. */
export function describeUndeclared(unmet: Unmet): string {
	return (
		`declares '${unmet.group}', which requires '${unmet.required}', and does not declare ` +
		`'${unmet.required}'`
	);
}
