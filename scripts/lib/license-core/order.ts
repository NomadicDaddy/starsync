/**
 * smokestack owns this file and delivers it with `bun run shared-core:write` (license-core group).
 *
 * Change it in smokestack, never in a repository that takes it: a copy edited anywhere else is
 * drift, fails check:shared-core, and is overwritten by the next write. Exports with no caller in
 * this repository are expected and must not be removed: the licence core is shared, and other
 * adopters consume them. A dead-code report naming an export in this file is not evidence that the
 * export is unused.
 */
/** Locale-independent ordering for deterministic generated compliance documents. */
export function byCodepoint(a: string, b: string): number {
	if (a < b) return -1;
	return a > b ? 1 : 0;
}
