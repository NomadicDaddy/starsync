/**
 * What a lock, and the record, name that no group's comparison ever looks at.
 *
 * The sweep runs group by group, and each group looks only at the repositories it reaches. That
 * leaves three things a repository's own check fails and the sweep never saw, because each is about
 * a group that does NOT reach it:
 *
 * - its lock names a group the manifest does not have;
 * - its lock names a group that exists and does not reach it;
 * - it holds a synced file of a group that neither reaches it nor is in its lock. This is the
 *   owner's side of the rule a repository applies to itself (self-check.ts): ANY synced path of a
 *   group its lock does not declare.
 *
 * So each reached repository that has a lock is held to them here, once per repository. A
 * repository with no lock is not looked at: it takes whatever discovery or a roster gives it, as
 * it always has. "Reaches" is the write plan's own answer (`reachingGroups`), not a second copy.
 *
 * The record is held the same way from its side: a delivery recorded under a group the manifest no
 * longer has belongs to no group's comparison either, and stays until it is forgotten on purpose.
 *
 * These findings have no group report to sit under, least of all the ones about a group that does
 * not exist, so they are returned on their own and printed in their own section of the report.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Finding, GroupReport } from './check.ts';
import type { Deliveries } from './deliveries.ts';
import type { SharedCoreGroup } from './manifest.ts';

import { syncedPaths } from './expected.ts';
import { reachingGroups } from './lock-write.ts';
import { type Lock, LOCK_FILE, readLock } from './lock.ts';

/** The lock of a repository, or null where it has none or one that cannot be read. */
function lockOf(path: string): Lock | null {
	try {
		return readLock(path);
	} catch {
		// Already a finding under every group that reaches it: lock-check.ts.
		return null;
	}
}

export function scopeFindings(
	reports: GroupReport[],
	manifest: SharedCoreGroup[],
	deliveries: Deliveries,
	fleetRoot: string,
	ownerRoot: string,
	only?: Set<string>,
): Finding[] {
	const findings: Finding[] = [];
	const known = new Set(manifest.map((group) => group.name));

	for (const directory of [...new Set(reports.flatMap((report) => report.reached))].sort()) {
		const path = join(fleetRoot, directory);
		const lock = lockOf(path);
		if (lock === null) continue;
		const stale = (group: string, detail: string): void => {
			findings.push({ detail, group, kind: 'stale-lock', target: directory });
		};
		const reaching = reachingGroups(directory, reports, manifest, fleetRoot, ownerRoot);

		for (const name of Object.keys(lock.groups).sort()) {
			if (!known.has(name)) {
				stale(
					name,
					`${LOCK_FILE} names the group '${name}', which the manifest does not have`,
				);
			} else if (!reaching.includes(name)) {
				stale(
					name,
					`${LOCK_FILE} names the group '${name}', which does not reach this repository`,
				);
			}
		}
		for (const group of manifest) {
			if (group.name in lock.groups || reaching.includes(group.name)) continue;
			for (const { path: synced } of syncedPaths(group)) {
				if (!existsSync(join(path, synced))) continue;
				stale(
					group.name,
					`${synced} is a synced file of '${group.name}', which neither reaches this ` +
						`repository nor is in its ${LOCK_FILE}`,
				);
			}
		}
	}

	for (const [directory, entry] of Object.entries(deliveries)) {
		if (only !== undefined && !only.has(directory)) continue;
		for (const name of Object.keys(entry.groups).filter((group) => !known.has(group))) {
			findings.push({
				detail:
					`v${entry.version} was delivered here as the group '${name}', which the manifest ` +
					`no longer has. Say that it is gone: bun run deliveries:forget ${directory} ` +
					`--group ${name}`,
				group: name,
				kind: 'lost-delivery',
				target: directory,
			});
		}
	}
	return findings;
}
