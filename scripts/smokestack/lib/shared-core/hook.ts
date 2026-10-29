/**
 * How a group's hook, and the guards that hook chains, stand in one target.
 *
 * Split out of check.ts because it answers a question that file only consumes. check.ts compares a
 * target's copy of a file against its owner; this decides, before and after that comparison, whether
 * the file is one the comparison may speak for at all: whether anything dispatches it here, and
 * whose a differing hook is. Every answer that is not "compare it" comes back as a finding with no
 * destination, which is what keeps the writer from ever acting on it.
 *
 * Nothing here opens the owner except `divergedHook`, which has to: a hook that differs is told
 * apart from a stale copy of ours only by the variants and generations the owner holds.
 */
import { join } from 'node:path';

import type { Finding } from './check.ts';
import type { SharedCoreFile, SharedCoreGroup } from './manifest.ts';

import {
	dispatcherBody,
	executableShell,
	hooksPath,
	invokes,
	namesTargetRoot,
} from './dispatch.ts';
import { readShared, sourcesOf } from './owner.ts';

/**
 * What git dispatches in one target, read once per target.
 *
 * The dispatcher is conditional on the target's dispatcher, exactly as the full hook variant is
 * conditional on the script contract. One repository in this fleet reaches leak-guard.sh through
 * simple-git-hooks and never sets core.hooksPath; it IS covered, and writing a .githooks/pre-commit
 * there would install a file git never executes while reporting the repository as current.
 *
 * The guards are unconditional on the REPOSITORY — they need only bash and git, which is why they
 * already work under a foreign dispatcher — but not on the DISPATCHER, which has to actually call
 * them. Where dispatch is ours that is settled by construction. Where it is not, `foreign` holds
 * whatever git really runs, and the guard's applicability is read out of it instead of assumed in
 * either direction.
 */
export interface Dispatch {
	/** core.hooksPath as configured, or an empty string when it is unset. */
	configured: string;
	/** The group has no hook, or core.hooksPath resolves to the group's targetRoot. */
	dispatches: boolean;
	/** The hook git really runs when dispatch is not ours, or null when there is none. */
	foreign: null | string;
	/**
	 * No dispatcher at all is not a foreign one declining our guards: nothing runs, so no guard
	 * does. Reading it as unmanaged dispatch plus not-applicable guards called deeper.project and
	 * three redesign trees covered (card 001c42b9). Unwritable, since the sync never sets a hooks
	 * path, and the hook and the guards it chains get no finding of their own.
	 */
	unguarded: boolean;
}

export function readDispatch(group: SharedCoreGroup, targetPath: string): Dispatch {
	const configured = group.hook === undefined ? '' : hooksPath(targetPath);
	const dispatches =
		group.hook === undefined || namesTargetRoot(targetPath, configured, group.targetRoot);
	const foreign = dispatches
		? null
		: dispatcherBody(targetPath, configured, group.hook as string);
	return { configured, dispatches, foreign, unguarded: !dispatches && foreign === null };
}

export function unguardedFinding(
	group: SharedCoreGroup,
	dispatch: Dispatch,
	target: string,
): Finding {
	const where =
		dispatch.configured === ''
			? 'core.hooksPath is unset and .git/hooks has none'
			: `${dispatch.configured} has none`;
	return {
		detail: `no ${group.hook} runs here: ${where}`,
		group: group.name,
		kind: 'unguarded',
		target,
	};
}

/**
 * Whether one of the group's files is compared in this target, and why not when it is not.
 * `unguarded` is the one answer with no finding of its own: the target already carries the single
 * finding that says nothing runs.
 */
export type Standing = 'applies' | 'not-applicable' | 'unguarded' | 'unmanaged-dispatch';

/**
 * A guard is delivered where something runs it, and nowhere else. Under a foreign dispatcher only
 * that dispatcher can answer which of our guards it chains, and it answers differently per file: in
 * the repository named above, the pre-commit that dispatcher runs calls leak-guard.sh, so that
 * guard is covered and verified here, while its pre-push calls only aidd-history-guard.sh and never
 * screenshot-guard.sh.
 *
 * Both assumptions are wrong. Treating every guard as applicable classifies screenshot-guard.sh as
 * `uncovered` — which carries a source and a destination, so `--write` delivers a guard nothing
 * will ever invoke and the note goes green while the repository is no safer. Treating none as
 * applicable stops verifying the guards a foreign dispatcher genuinely does run, which is most of
 * the coverage such a repository has. So this reads the dispatcher rather than guessing, and a
 * guard it does not name gets a classification with no destination, which is what makes it
 * unwritable.
 */
export function standingOf(
	group: SharedCoreGroup,
	name: string,
	dispatch: Dispatch,
	chained: Set<string>,
): Standing {
	if (dispatch.dispatches) return 'applies';
	const conditional = name === group.hook || chained.has(name);
	if (dispatch.unguarded) return conditional ? 'unguarded' : 'applies';
	if (name === group.hook) return 'unmanaged-dispatch';
	if (chained.has(name) && !invokes(executableShell(dispatch.foreign ?? ''), name)) {
		return 'not-applicable';
	}
	return 'applies';
}

/** The finding for a file that is not compared here because of how this target dispatches. */
export function standingFinding(
	group: SharedCoreGroup,
	name: string,
	standing: 'not-applicable' | 'unmanaged-dispatch',
	target: string,
): Finding {
	const detail =
		standing === 'unmanaged-dispatch'
			? `${name}: core.hooksPath does not resolve to ${group.targetRoot}; dispatch is not managed here`
			: `${group.targetRoot}/${name} does not apply: ${group.hook} here is the target's own and does not run it`;
	return { detail, group: group.name, kind: standing, target };
}

/**
 * Whose a hook is, by its content alone.
 *
 * Two ways a differing hook is NOT drift, both of which the existing installers already honor and
 * neither of which the write path may ever overwrite. A hook missing the group's marker belongs to
 * another tool; core.hooksPath holds one hook of each name, so replacing it disables whatever was
 * there. A hook carrying the local-chain marker is a repository that deliberately maintains its own
 * chain around the guard, which is a correct configuration — calling it drift is how a check
 * pressures someone into reverting working code.
 */
export function hookClaim(
	group: SharedCoreGroup,
	actual: string,
): 'foreign-hook' | 'local-chain' | 'ours' {
	if (group.hookMarker !== undefined && !actual.includes(group.hookMarker)) return 'foreign-hook';
	if (group.localChainMarker !== undefined && actual.includes(group.localChainMarker)) {
		return 'local-chain';
	}
	return 'ours';
}

/**
 * True when a hook that is ours by marker matches no current variant and no generation the owner
 * once committed.
 *
 * Ours by marker, undeclared, and matching NO variant — which content cannot tell apart from a
 * hand-written chain whose author never added the marker. Both call the guard and both match
 * neither variant, so overwriting deletes real commit-time checks and leaving it lets a stale copy
 * read as covered.
 *
 * Fatal AND unwritable, which no other kind is. `install-leak-guard.ts` refuses this state
 * outright, and calling it plain `drift` would have the writer overwrite it; either reading picks a
 * loser: refuse and let a stale hook go unnoticed, or overwrite and delete someone's checks. This
 * picks neither. The gate stays red until a person decides, and the writer is given no destination
 * to decide it with.
 *
 * Matching the OTHER variant is deliberately not this: that is a target whose package.json now
 * satisfies the script contract it did not before, and moving it to the right variant is exactly
 * what `requiresScripts` is for. It is drift. Nor is matching a generation the owner once
 * committed: that is the stale copy drift was defined for, and the only way a fleet ever takes a
 * hook change (the first change to pre-push since aidd 3.0.0 read all sixty targets as diverged).
 */
function divergedHook(
	group: SharedCoreGroup,
	file: SharedCoreFile,
	actual: string,
	ownerRoot: string,
	generationsOf: (source: string) => string[],
): boolean {
	const variants = sourcesOf(file).map((s) => readShared(join(ownerRoot, group.sourceRoot, s)));
	if (variants.includes(actual)) return false;
	return !sourcesOf(file).flatMap(generationsOf).includes(actual);
}

/**
 * The finding for a hook that is present and differs from the variant this target should hold, or
 * null when the difference is plain drift the writer replaces.
 */
export function differingHookFinding(
	group: SharedCoreGroup,
	file: SharedCoreFile,
	actual: string,
	target: string,
	ownerRoot: string,
	generationsOf: (source: string) => string[],
): Finding | null {
	const name = file.target ?? file.source;
	const claim = hookClaim(group, actual);
	if (claim === 'foreign-hook') {
		return {
			detail: `${name} exists and is not ours (no '${group.hookMarker}'); refusing to claim it`,
			group: group.name,
			kind: 'foreign-hook',
			target,
		};
	}
	if (claim === 'local-chain') {
		return {
			detail: `${name} is a hand-maintained local chain; the guard it carries was verified, the hook body is the target's own`,
			group: group.name,
			kind: 'local-chain',
			target,
		};
	}
	if (!divergedHook(group, file, actual, ownerRoot, generationsOf)) return null;
	return {
		detail: `${name} calls the guard but matches no current variant and does not declare itself a local chain — either delete it and re-run to take the current variant, or add '${group.localChainMarker ?? 'the local-chain marker'}' to its header if its extra steps are deliberate`,
		group: group.name,
		kind: 'diverged-hook',
		target,
	};
}
