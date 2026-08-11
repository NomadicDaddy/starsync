/**
 * What a group's OWNER has to hold for the group to describe anything real.
 *
 * These run before any target is looked at, and they throw rather than reporting findings: a
 * manifest that misdescribes its own owner is not a fleet state to classify, it is a bug in the
 * manifest, and every target result computed from it would be noise.
 *
 * They are split out of check.ts because they ask a different question from everything there.
 * check.ts compares a target against the owner; this file never opens a target at all.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { SharedCoreFile, SharedCoreGroup } from './manifest.ts';

import { invokedScripts } from './dispatch.ts';

/**
 * Every source a group could install, including the fallback variants. All of them must exist in
 * the owning repository or the group is a description of something that is not there.
 */
export function sourcesOf(file: SharedCoreFile): string[] {
	return file.fallbackSource === undefined ? [file.source] : [file.source, file.fallbackSource];
}

export function assertSourcesExist(group: SharedCoreGroup, ownerRoot: string): void {
	const missing = group.files
		.flatMap(sourcesOf)
		.filter((source) => !existsSync(join(ownerRoot, group.sourceRoot, source)));
	if (missing.length > 0) {
		throw new Error(
			`group '${group.name}': ${missing.length} source file(s) do not exist in ${group.owner} ` +
				`under ${group.sourceRoot}: ${missing.join(', ')}. A manifest naming files that are ` +
				'not there reports coverage it does not have.',
		);
	}
}

/**
 * A file's variants must actually be different files.
 *
 * `fallbackSource` exists to install something LESSER where the canonical variant cannot run — a
 * pre-commit that skips the tasks a target's package.json does not define. The two are selected
 * between per target by `requiresScripts`, and every consumer of that choice assumes the choice
 * means something: `resolveSource` picks one, `diverged-hook` classification asks whether a target's
 * hook matches neither, and the writer replaces one with the other. If the owner's two variants have
 * become the same bytes, all three questions still answer, and all three answer "fine" — a fleet
 * where the richer hook no longer exists anywhere reads as fully covered.
 *
 * That is not hypothetical. On 2026-08-09 `ensureHistoryGuard` began copying
 * `pre-commit-leak-guard-only` over `pre-commit` in every project it touched, this group's owner
 * included. The only test guarding that copy is a marker both variants carry, so nothing refused it,
 * and because a group's owner is excluded from its own target discovery the corruption surfaced only
 * as sixteen `DIVERGED-HOOK` findings against sixteen OTHER repositories — every one of them
 * correct, none of them naming the one bad file. This is the assertion that would have named it.
 *
 * It throws rather than reporting, for the same reason its neighbours do: a fleet-wide comparison
 * computed against a corrupted baseline is not a fleet state, it is noise with the wrong file at the
 * top of it.
 */
export function assertVariantsDiffer(group: SharedCoreGroup, ownerRoot: string): void {
	const collapsed = group.files
		.filter((file) => file.fallbackSource !== undefined)
		.filter((file) => {
			const [source, fallback] = sourcesOf(file);
			return (
				readFileSync(join(ownerRoot, group.sourceRoot, source as string), 'utf8') ===
				readFileSync(join(ownerRoot, group.sourceRoot, fallback as string), 'utf8')
			);
		})
		.map((file) => `${file.source} == ${file.fallbackSource as string}`);

	if (collapsed.length > 0) {
		throw new Error(
			`group '${group.name}': ${collapsed.length} file(s) whose variants are byte-identical in ` +
				`${group.owner} under ${group.sourceRoot}: ${collapsed.join(', ')}. One variant has ` +
				'been overwritten by the other, so the choice `requiresScripts` makes between them no ' +
				'longer chooses anything and every target reads as covered by whichever survived. ' +
				'Restore the overwritten variant from history before running this again.',
		);
	}
}

/**
 * A hook may only chain guards its own group delivers.
 *
 * This is the rule gatesync.md 3a specified as a loader rule and it is not one, for a reason worth
 * stating: `loadManifest` is handed the running repository's `scripts/`, while a group's hook body
 * lives in its OWNER, which is usually a sibling. A loader that read it would either resolve the
 * owner from `cwd()` — the one inference this whole subsystem exists to refuse — or answer nothing
 * at all from a repository that owns no groups. So it sits beside `assertSourcesExist`, which is
 * the same shape of question: does the manifest describe what is actually on the owner's disk.
 *
 * Both directions of the pair are load-bearing and only this one is dangerous. `assertSourcesExist`
 * catches a group promising a file that is not there, which fails visibly. This catches a group
 * delivering a hook that calls a guard nobody ships — and because these hooks run under
 * `set -euo pipefail`, that is not a partial install but a repository whose every commit or push
 * fails. It happened on 2026-08-04 to eleven repositories at once, and `--write` shipped on
 * 2026-08-07 with nothing standing between it and doing it again.
 *
 * Every variant is scanned, not only the canonical one: a fallback hook is installed into precisely
 * the repositories least able to diagnose it.
 */
export function assertHookChainIsCarried(group: SharedCoreGroup, ownerRoot: string): void {
	if (group.hook === undefined) return;
	// Basenames on both sides, because `invokedScripts` reports basenames and a group rooted at the
	// repository root names its files by path. Two carried files sharing a basename would make this
	// accept a little more than it should, which is the harmless direction and has no instance today.
	const carried = new Set(group.files.map((f) => basename(f.target ?? f.source)));
	const unshipped: string[] = [];

	for (const file of group.files.filter((f) => (f.target ?? f.source) === group.hook)) {
		for (const source of sourcesOf(file)) {
			const body = readFileSync(join(ownerRoot, group.sourceRoot, source), 'utf8');
			for (const invoked of invokedScripts(body)) {
				if (!carried.has(invoked)) unshipped.push(`${source} runs ${invoked}`);
			}
		}
	}

	if (unshipped.length > 0) {
		throw new Error(
			`group '${group.name}': the hook chains ${unshipped.length} script(s) the group does ` +
				`not carry: ${unshipped.join(', ')}. These hooks run under \`set -euo pipefail\`, so ` +
				'installing one without a guard it calls does not leave the target partly covered — ' +
				'it leaves every commit or push in that repository failing. Add the file to the ' +
				'group, or stop chaining it.',
		);
	}
}
