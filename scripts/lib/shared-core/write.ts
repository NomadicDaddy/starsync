/**
 * The write half of the shared-core sync.
 *
 * It has no rules of its own. Its entire worklist is the `uncovered` and `drift` findings that
 * check.ts already produced, and it reaches them only through the `source`/`destination` fields
 * that classifier sets — so a foreign hook, a hand-maintained local chain, a repository whose
 * dispatcher is not ours, and a `seeded` file that has since diverged are all unwritable here
 * because they never arrive carrying a destination. That is deliberate. The failure this design
 * rules out is a second copy of the classification rules drifting out of step with the first, which
 * is the same defect at one level up that the whole subsystem exists to catch one level down.
 *
 * Two guards are the writer's own, because neither is a question `--check` asks:
 *
 *   1. OWNERSHIP. A group is pushed only from the repository that owns it. This generalizes
 *      `isSpernakitItself`, which existed because sync-license-core.ts ships to derived apps and a
 *      run from one of them would have made a copy the source and overwritten every adopter from
 *      it. The manifest names an owner per group, so the check is per group rather than per script.
 *   2. UNCOMMITTED WORK. Overwriting a target's committed divergence is this script's job and git
 *      can recover it. Uncommitted work is different: the write destroys it with no undo and the
 *      only trace is a cheerful "wrote" line. A git inspection that fails is treated as a refusal,
 *      not as a pass, because the script cannot then prove the overwrite is recoverable.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import type { Finding } from './check.ts';
import type { SharedCoreGroup } from './manifest.ts';

export interface WriteOutcome {
	blocked: Finding[];
	skipped: Finding[];
	written: Finding[];
}

/** The repository the process is standing in, by package name rather than by directory. */
export function repoIdentity(root: string): null | string {
	try {
		const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
			name?: string;
		};
		return parsed.name ?? null;
	} catch {
		return null;
	}
}

/**
 * A group may be written only from its owner. Returns the reason it may not, or null when it may.
 *
 * Reported rather than thrown: running `--write` from spernakit against a manifest that also holds
 * aidd-owned groups is the normal case, not a mistake, and it should push the license core and say
 * plainly that it left the three hook groups to aidd.
 */
export function ownershipRefusal(group: SharedCoreGroup, root: string): null | string {
	const identity = repoIdentity(root);
	if (identity === null) {
		return `cannot identify this repository (no readable package.json at ${root})`;
	}
	if (identity !== group.owner) {
		return `owned by ${group.owner}, and this is ${identity}`;
	}
	return null;
}

/**
 * True when a target file has uncommitted changes in its own repository. Throws when git cannot
 * answer, which the caller treats as a refusal to write that file.
 */
function hasUncommittedChanges(targetRoot: string, relativePath: string): boolean {
	const result = Bun.spawnSync(
		['git', '-C', targetRoot, 'status', '--porcelain', '--', relativePath],
		{ stderr: 'pipe', stdout: 'pipe', windowsHide: true },
	);
	if (result.exitCode !== 0) {
		const detail = result.stderr.toString().trim();
		throw new Error(
			`git could not inspect ${relativePath} in ${targetRoot}.${detail ? ` ${detail}` : ''}`,
		);
	}
	return result.stdout.toString().trim().length > 0;
}

/**
 * Makes a delivered hook executable, on disk and in the index.
 *
 * The filesystem bit alone is not enough and the reason is not portability pedantry: these
 * repositories run with `core.fileMode=false` on Windows, so git ignores the on-disk mode and
 * records the hook as 100644 — and git will not run a non-executable hook on Linux or macOS.
 * Anyone cloning there would get a guard that is silently disabled, which is worse than an absent
 * one because the repository reads as protected. The index mode is the only part that survives a
 * clone. `install-leak-guard.ts` and `install-history-guard.ts` have both done this since they were
 * written; the shared-core writer shipped on 2026-08-07 without it and would have delivered exactly
 * that dead hook the first time it covered a new repository.
 *
 * `--add` is what makes `--chmod` reach a file git does not track yet, and it stages the hook as a
 * side effect. That is a real cost and it is the smaller one: the alternative is a writer that
 * cannot correctly deliver a hook at all. Failures are reported rather than thrown — the content is
 * already written, and a mode git refused to record is a partial result the caller has to see.
 */
function makeExecutable(
	targetRoot: string,
	relativePath: string,
	destination: string,
): null | string {
	try {
		chmodSync(destination, 0o755);
	} catch {
		/* Filesystems without POSIX modes; the index mode below is the one that matters. */
	}
	const result = Bun.spawnSync(
		['git', '-C', targetRoot, 'update-index', '--add', '--chmod=+x', relativePath],
		{ stderr: 'pipe', stdout: 'pipe', windowsHide: true },
	);
	if (result.exitCode === 0) return null;
	const detail = result.stderr.toString().trim();
	return `wrote ${relativePath} but could not record its executable bit${detail ? `: ${detail}` : ''}`;
}

/**
 * The repository root a destination sits inside, recovered from the finding rather than passed
 * alongside it. `destination` is `<fleetRoot>/<directory>/<targetRoot>/<name>`, and the writer needs
 * the first two segments to ask git about the third.
 */
function targetRootOf(finding: Finding, fleetRoot: string): string {
	return join(fleetRoot, finding.target);
}

/**
 * Applies every writable finding in a report. `dryRun` runs all the same refusals and reports what
 * it would have done, so the rehearsal exercises the guards rather than skipping past them.
 */
export function applyFindings(
	findings: Finding[],
	fleetRoot: string,
	dryRun: boolean,
): WriteOutcome {
	const outcome: WriteOutcome = { blocked: [], skipped: [], written: [] };

	for (const finding of findings) {
		// Not a mistake and not filtered upstream: this is where every non-writable kind lands, and
		// it lands here by having no destination rather than by being named in a list.
		if (finding.destination === undefined || finding.source === undefined) {
			outcome.skipped.push(finding);
			continue;
		}

		const targetRoot = targetRootOf(finding, fleetRoot);
		const relativePath = relative(targetRoot, finding.destination).replaceAll('\\', '/');

		let dirty: boolean;
		try {
			dirty = hasUncommittedChanges(targetRoot, relativePath);
		} catch (err) {
			outcome.blocked.push({
				...finding,
				detail: `${finding.detail} — ${err instanceof Error ? err.message : String(err)}`,
			});
			continue;
		}
		if (dirty) {
			outcome.blocked.push({
				...finding,
				detail: `${relativePath} has uncommitted changes this write would destroy`,
			});
			continue;
		}

		let note: null | string = null;
		if (!dryRun) {
			mkdirSync(dirname(finding.destination), { recursive: true });
			writeFileSync(finding.destination, readFileSync(finding.source, 'utf8'));
			if (finding.executable === true) {
				note = makeExecutable(targetRoot, relativePath, finding.destination);
			}
		}
		outcome.written.push(note === null ? finding : { ...finding, detail: note });
	}

	return outcome;
}
