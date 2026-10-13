import type { GroupReport } from './check.ts';
import type { SharedCoreGroup } from './manifest.ts';

import { skipReason } from './eligibility.ts';
import { readScripts, resolveTargets } from './targets.ts';

/**
 * The name of every manifest group that reaches the repository at `directory`, in manifest order.
 *
 * The one answer to "which groups does this repository take", asked by the write's plan and by the
 * sweep's check of what a lock names (lock-scope.ts), so the two cannot disagree. `reports` are the
 * groups this run compared, and their answer is the comparison's own. A group outside the run was
 * not compared, so it is asked of its target model here, through the same eligibility rule.
 */
export function reachingGroups(
	directory: string,
	reports: GroupReport[],
	all: SharedCoreGroup[],
	fleetRoot: string,
	ownerRoot: string,
): string[] {
	const reportOf = new Map(reports.map((report) => [report.group, report]));
	return all
		.filter((group) => {
			const report = reportOf.get(group.name);
			if (report !== undefined) return report.reached.includes(directory);
			return resolveTargets(group, fleetRoot, ownerRoot, new Set([directory])).some(
				(target) => skipReason(group, target, readScripts(target.path)) === null,
			);
		})
		.map((group) => group.name);
}
