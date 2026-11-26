/**
 * The owner's check of declared membership (opt-in-membership-in-the-lock), beside the per-group
 * comparison in check.ts.
 *
 * Two failures, both about a repository whose answer to "what do you take" cannot be trusted:
 *   - `unreadable-membership`: its lock is untracked, does not parse at HEAD, or has uncommitted
 *     changes to which declared groups it names (membership.ts), so the declared groups cannot see
 *     it at all. Reported, never read as opted
 *     out: a bad merge or a half-written lock would otherwise drop it from every group silently,
 *     the hazard the rosters' presence check guarded, in reverse (Morticia D-1).
 *   - `undeclared-carrier`: it has a committed lock and holds every synced file of a declared group
 *     (carriesGroup) that lock no longer declares, so it is still running files nothing keeps
 *     current. Losing a declaration is then as loud as losing a roster used to be. Retiring the
 *     group on purpose, while the lock still declares it, removes the files (retire.ts) and
 *     clears this.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import type { Finding } from './check.ts';
import type { SharedCoreGroup } from './manifest.ts';
import type { Membership } from './membership.ts';

import { carriesGroup, siblingRepositories } from './targets.ts';

export function membershipFindings(
	manifest: SharedCoreGroup[],
	fleetRoot: string,
	read: (root: string) => Membership,
	only?: Set<string>,
): Finding[] {
	const findings: Finding[] = [];
	const declaredGroups = manifest.filter((group) => group.targets.model === 'declared');
	if (declaredGroups.length === 0) return findings;
	const owners = new Set(declaredGroups.map((group) => group.owner));
	for (const owner of owners) {
		for (const target of siblingRepositories(fleetRoot, owner)) {
			if (only !== undefined && !only.has(target.directory)) continue;
			const membership = read(target.path);
			if (membership.kind === 'unreadable') {
				findings.push({
					detail:
						`its membership cannot be read: ${membership.reason}. Commit or fix the lock ` +
						'there; until then no declared group reaches it.',
					group: '(membership)',
					kind: 'unreadable-membership',
					target: target.directory,
				});
				continue;
			}
			// A repository with no lock never declared anything to lose: a copy there is an
			// installer's or a template's, which the lock check already leaves unjudged.
			if (membership.kind !== 'declared') continue;
			for (const group of declaredGroups.filter((g) => g.owner === owner)) {
				if (membership.groups.has(group.name) || !carriesGroup(group, target.path))
					continue;
				findings.push({
					detail:
						`it carries ${group.name}'s files, but its committed lock does not declare ` +
						`the group. To keep it, declare it there again ("${group.name}": {}). To ` +
						'leave it, restore the lock entry as it was last committed and retire it ' +
						`with shared-core:write --only ${target.directory} --retire ${group.name}, ` +
						'which needs the hashes that entry records.',
					group: group.name,
					kind: 'undeclared-carrier',
					target: target.directory,
				});
			}
		}
	}
	return findings;
}
