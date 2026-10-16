/**
 * The read-only half of the shared-core sync: compare, classify, never write.
 *
 * Detection ships before the write path on purpose. It is the gate, it is independently useful, and
 * it cannot break anything — whereas a write path built first has nothing to prove it is correct
 * except the writes it already made.
 *
 * The classification below is the whole design. A file that is ABSENT in a target and a file that
 * is PRESENT AND DIFFERENT are not the same problem: the first is a repository this rollout has not
 * reached yet, the second is a repository running a stale copy of a guard while reporting as
 * covered. Only the second fails the gate. Collapsing them would make this red on day one across a
 * fleet the write path has not been built for, and a gate that is red by construction gets removed.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Deliveries } from './deliveries.ts';
import type { SharedCoreGroup } from './manifest.ts';

import { departedFindings } from './delivery-check.ts';
import { chainedByHook } from './dispatch.ts';
import { assertPackageIdentity, skipReason } from './eligibility.ts';
import {
	differingHookFinding,
	readDispatch,
	standingFinding,
	standingOf,
	unguardedFinding,
} from './hook.ts';
import { lockFindings } from './lock-check.ts';
import { LOCK_FILE } from './lock.ts';
import {
	assertHookChainIsCarried,
	assertSourcesExist,
	assertVariantsDiffer,
	generationReader,
	readShared,
	resolveSource,
} from './owner.ts';
import { readScripts, resolveTargets } from './targets.ts';
import { wiringFindings } from './wiring.ts';

export type FindingKind =
	| 'diverged-hook'
	| 'drift'
	| 'foreign-hook'
	| 'local-chain'
	| 'lost-delivery'
	| 'not-applicable'
	| 'not-run'
	| 'stale-lock'
	| 'uncovered'
	| 'unguarded'
	| 'unmanaged-dispatch'
	| 'unwired';

/**
 * `destination` and `source` are absolute paths, set only on the two kinds a write path may act on:
 * `uncovered` (deliver it) and `drift` (replace it). Every other kind leaves them undefined, which
 * is the mechanism rather than a convenience — the writer takes its worklist from these fields and
 * therefore cannot touch a file this checker did not already classify as writable. A foreign hook,
 * a hand-maintained chain, a repository whose dispatcher is not ours, and a guard that repository's
 * dispatcher does not chain are unwritable by construction, not by a second copy of the rules that
 * could fall out of step with these.
 */
export interface Finding {
	destination?: string;
	detail: string;
	/**
	 * The file is the group's hook, so git has to be able to execute it. Carried on the finding
	 * rather than looked up by the writer for the same reason `destination` is: everything the write
	 * path acts on comes from the classifier, and a writer that re-derived "is this the hook" from
	 * the manifest would be a second copy of the rule.
	 */
	executable?: true;
	group: string;
	kind: FindingKind;
	source?: string;
	target: string;
}

export interface GroupReport {
	findings: Finding[];
	group: string;
	matched: number;
	owner: string;
	/** The directory of every target compared, which is every target the group reaches. */
	reached: string[];
	skipped: string[];
	targets: number;
}

export function checkGroup(
	group: SharedCoreGroup,
	fleetRoot: string,
	ownerRoot: string,
	only?: Set<string>,
	// The owner's record of deliveries for this fleet root. Empty where the owner holds none, which
	// the entry point fails on its own account; a caller comparing files alone passes nothing.
	deliveries: Deliveries = {},
): GroupReport {
	assertSourcesExist(group, ownerRoot);
	// After assertSourcesExist, which is what lets this one read both variants without guarding.
	assertVariantsDiffer(group, ownerRoot);
	assertHookChainIsCarried(group, ownerRoot);
	const chained = chainedByHook(group, ownerRoot);
	const generationsOf = generationReader(ownerRoot, group.sourceRoot);

	const report: GroupReport = {
		findings: [],
		group: group.name,
		matched: 0,
		owner: group.owner,
		reached: [],
		skipped: [],
		targets: 0,
	};

	const skipReasons = new Map<string, string>();
	for (const target of resolveTargets(group, fleetRoot, ownerRoot, only)) {
		const scripts = readScripts(target.path);
		// A skipped target produces no findings, and the write path takes its worklist from findings,
		// so every exclusion eligibility.ts makes is unwritable by the same construction that makes a
		// foreign hook unwritable — not by a second copy of the rule kept in the writer.
		const skip = skipReason(group, target, scripts);
		if (skip !== null) {
			report.skipped.push(`${target.directory} (${skip})`);
			skipReasons.set(target.directory, skip);
			continue;
		}
		assertPackageIdentity(target);
		report.targets += 1;
		report.reached.push(target.directory);
		const first = report.findings.length;

		// Whether anything dispatches this group's hook here, and which guards it reaches: hook.ts.
		const dispatch = readDispatch(group, target.path);
		if (dispatch.unguarded) {
			report.findings.push(unguardedFinding(group, dispatch, target.directory));
		}

		// A target with a lock is held to every file of the group whatever it dispatches. Its lock
		// records them all, because what a clone dispatches is not part of the repository (see
		// expected.ts), so standing a file down here would leave the lock unwritable or untrue. It
		// is still told that nothing runs, or that dispatch is not ours. A target with no lock is
		// stood down exactly as before.
		const locked = existsSync(join(target.path, LOCK_FILE));

		for (const file of group.files) {
			const name = file.target ?? file.source;
			const standing = standingOf(group, name, dispatch, chained);
			if (standing === 'unmanaged-dispatch' || (standing === 'not-applicable' && !locked)) {
				report.findings.push(standingFinding(group, name, standing, target.directory));
			}
			if (standing !== 'applies' && !locked) continue;
			const source = resolveSource(file, scripts);
			const sourcePath = join(ownerRoot, group.sourceRoot, source);
			const expected = readShared(sourcePath);
			const destination = join(target.path, group.targetRoot, name);

			if (!existsSync(destination)) {
				report.findings.push({
					destination,
					detail: `${group.targetRoot}/${name} is absent`,
					group: group.name,
					kind: 'uncovered',
					source: sourcePath,
					target: target.directory,
					...(name === group.hook ? { executable: true as const } : {}),
				});
				continue;
			}

			// Idempotence by content, never by presence. A presence check is what reported eleven
			// repositories as current while they ran a pre-push one generation behind. Content
			// excludes line endings: see readShared.
			const actual = readShared(destination);
			if (actual === expected) {
				report.matched += 1;
				continue;
			}

			// A hook that differs is not always drift: it may be another tool's, a chain kept by hand,
			// or ours and matching nothing the owner ever shipped. hook.ts says which, and none of
			// those three carries a destination.
			if (name === group.hook) {
				const finding = differingHookFinding(
					group,
					file,
					actual,
					target.directory,
					ownerRoot,
					generationsOf,
				);
				if (finding !== null) {
					report.findings.push(finding);
					continue;
				}
			}

			// A seeded file is written once and never touched again, so a difference is the target
			// living its own life, which is the point. Only synced files can drift.
			if (file.disposition === 'seeded') {
				report.matched += 1;
				continue;
			}
			report.findings.push({
				destination,
				detail: `${group.targetRoot}/${name} differs from ${group.owner}${source === file.source ? '' : ` (variant ${source})`}`,
				group: group.name,
				kind: 'drift',
				source: sourcePath,
				target: target.directory,
				...(name === group.hook ? { executable: true as const } : {}),
			});
		}

		report.findings.push(...wiringFindings(group, target, scripts));
		// Last, because it is judged against everything this target was just found to hold.
		const entry = deliveries[target.directory];
		report.findings.push(
			...lockFindings(group, target, ownerRoot, report.findings.slice(first), entry),
		);
	}

	// A repository the record says was delivered this group, and which was not reached above.
	report.findings.push(
		...departedFindings(group, deliveries, fleetRoot, report.reached, skipReasons, only),
	);
	return report;
}

/**
 * The kinds that fail the gate. Two are a target running a stale copy of a guard while reporting as
 * covered: see the header for why absence is not one of them, and `divergedHook` in hook.ts for why
 * that fatal kind is deliberately unwritable. The other two come from a target's lock: files that
 * are current under a lock that does not say so, and a file the lock's delivery included that is
 * gone, which is the one absence that is not a rollout gap. See lock-check.ts. The last is a group
 * whose wiring is its point, held by a repository that does not run it: see wiring.ts.
 */
export function isFatal(finding: Finding): boolean {
	return (
		finding.kind === 'diverged-hook' ||
		finding.kind === 'drift' ||
		finding.kind === 'lost-delivery' ||
		finding.kind === 'not-run' ||
		finding.kind === 'stale-lock'
	);
}
