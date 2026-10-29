/**
 * The hooks git runs, and which of a repository's own hooks would stop running when core.hooksPath
 * moves off the folder that holds them. A delivered hook runs the repository's own hook of the same
 * name from .githooks; nothing runs a hook of any other name, so moving the hooks path past one
 * silently disables it. Every path that moves core.hooksPath asks this first: the write
 * (move-home.ts), the installers (guard-install/delegate.ts), and leak-guard-setup.sh, which repeats
 * the list in shell.
 */
import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';

import type { SharedCoreGroup } from './manifest.ts';

import { installedPath } from './lock.ts';

/**
 * Every client-side hook name git runs from a hooks folder (githooks(5)), the p4 hooks of git-p4
 * included. .githooks/leak-guard-setup.sh repeats this list in shell.
 */
export const GIT_HOOKS = [
	'applypatch-msg',
	'commit-msg',
	'fsmonitor-watchman',
	'p4-changelist',
	'p4-post-changelist',
	'p4-pre-submit',
	'p4-prepare-changelist',
	'post-applypatch',
	'post-checkout',
	'post-commit',
	'post-index-change',
	'post-merge',
	'post-rewrite',
	'pre-applypatch',
	'pre-auto-gc',
	'pre-commit',
	'pre-merge-commit',
	'pre-push',
	'pre-rebase',
	'prepare-commit-msg',
	'push-to-checkout',
	'reference-transaction',
	'sendemail-validate',
];

/** Everything the hook groups install, moved or new: the files a delivered hooks folder holds. */
export function deliveredHooks(groups: SharedCoreGroup[]): string[] {
	return groups
		.filter((group) => group.hook !== undefined)
		.flatMap((group) => group.files.map((file) => installedPath(group, file)));
}

/**
 * The hooks git runs from `configured` that no delivered hook chains to, as root-relative paths:
 * a delivered hook runs the repository's own hook of its own name, and nothing runs any other.
 */
export function unchainedHooks(root: string, configured: string, delivered: string[]): string[] {
	const chained = new Set(delivered.map((path) => posix.basename(path)));
	return GIT_HOOKS.filter(
		(name) => !chained.has(name) && existsSync(join(root, configured, name)),
	).map((name) => posix.join(configured, name));
}
