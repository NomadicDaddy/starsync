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
 * A shared file's text with line endings normalised. A Windows checkout under core.autocrlf rewrites
 * an LF blob as CRLF in the working tree, so a byte comparison reports the whole file as drifted
 * although the committed content is the owner's exactly. Line endings are the checkout's, not the
 * file's; every comparison in this subsystem reads through here so they cannot disagree about it.
 */
export function readShared(path: string): string {
	return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
}

/**
 * Every committed generation of one owner file, newest first, normalized as readShared normalizes
 * a checkout. Empty when the owner is not a repository or never committed the file.
 *
 * What a target holds is compared against these as well as against the current variants, because
 * a hook equal to a generation the owner once shipped is a stale copy of ours — drift, which the
 * writer replaces — and not a hand-written chain. Without this every change to a single-variant
 * hook made the whole fleet unwritable: the first change to `.githooks/pre-push` since aidd 3.0.0
 * classified all sixty targets as `diverged-hook`, each one holding exactly the previous owner copy.
 */
export function committedGenerations(ownerRoot: string, relativePath: string): string[] {
	const log = Bun.spawnSync(['git', '-C', ownerRoot, 'log', '--format=%H', '--', relativePath], {
		stderr: 'pipe',
		stdout: 'pipe',
		windowsHide: true,
	});
	if (log.exitCode !== 0) return [];
	const generations: string[] = [];
	for (const line of log.stdout.toString().split('\n')) {
		const sha = line.trim();
		if (sha === '') continue;
		const show = Bun.spawnSync(['git', '-C', ownerRoot, 'show', `${sha}:${relativePath}`], {
			stderr: 'pipe',
			stdout: 'pipe',
			windowsHide: true,
		});
		// A commit in the file's log that cannot show it is the one that deleted it.
		if (show.exitCode !== 0) continue;
		generations.push(show.stdout.toString().replaceAll('\r\n', '\n'));
	}
	return generations;
}

/**
 * `committedGenerations` for one group, read once per source rather than once per target: it is
 * two git invocations per generation, and the fleet is sixty targets wide.
 */
export function generationReader(
	ownerRoot: string,
	sourceRoot: string,
): (source: string) => string[] {
	const generations = new Map<string, string[]>();
	return (source) => {
		const cached = generations.get(source);
		if (cached !== undefined) return cached;
		const read = committedGenerations(ownerRoot, `${sourceRoot}/${source}`);
		generations.set(source, read);
		return read;
	};
}

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
				readShared(join(ownerRoot, group.sourceRoot, source as string)) ===
				readShared(join(ownerRoot, group.sourceRoot, fallback as string))
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
 * This is an owner-validation rule rather than a loader rule for a reason worth stating:
 * `loadManifest` is handed the running repository's `scripts/`, while a group's hook body
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
