/**
 * The answers one sync run remembers: git questions about the owner's history and each target's
 * config, which do not change while one run goes on, so each module asks once and keeps the
 * answer in a map made here.
 *
 * WHY ONE PLACE. The command line is one run per process, so a module-level map was one run's
 * memory. An in-process caller (runSharedCoreCli, test-suite-lanes-stage-two) makes several runs
 * in one process, between which a repository's HEAD, tags or hooks setting can move; a map that
 * outlived its run would answer the next run with the last run's state (Morticia #55078).
 * runSharedCoreSync empties every map made here before it starts, so each run, spawned or
 * in-process, starts with none.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */

const clears: (() => void)[] = [];

/** A map that holds for one run: emptied by `forgetRunAnswers` when the next run starts. */
export function runCache<K, V>(): Map<K, V> {
	const cache = new Map<K, V>();
	clears.push(() => cache.clear());
	return cache;
}

/** Empty every map made by `runCache`, at the start of a run. */
export function forgetRunAnswers(): void {
	for (const clear of clears) clear();
}
