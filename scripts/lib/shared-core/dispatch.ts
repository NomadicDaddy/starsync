/**
 * What git actually runs in a repository, and which of a group's files it calls.
 *
 * Split out of check.ts because it answers a different question. check.ts asks whether a target's
 * copy of a file matches its owner; this asks whether anything in that target will ever execute it.
 * Both are needed to classify a guard, and conflating them is what made `--write` willing to
 * deliver a file into a repository whose dispatcher does not chain it.
 *
 * NOTHING HERE IS DECLARED IN THE MANIFEST, deliberately. A hook body already states which guards
 * it chains, and a target's dispatcher already states which of ours it calls. Restating either in
 * JSON would create a second copy free to drift from the first, which is the defect this whole
 * subsystem exists to remove one level down.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { SharedCoreGroup } from './manifest.ts';

/**
 * The single value git dispatches hooks from. An empty string means unset, in which case git runs
 * .git/hooks and a file written to the group's targetRoot would never execute.
 */
export function hooksPath(repoPath: string): string {
	const result = Bun.spawnSync(['git', '-C', repoPath, 'config', '--local', 'core.hooksPath'], {
		stderr: 'pipe',
		stdout: 'pipe',
		windowsHide: true,
	});
	return result.success ? result.stdout.toString().trim() : '';
}

/**
 * True when `body` invokes `file` as a path rather than merely containing its name somewhere.
 *
 * The boundary is the whole point. A bare `includes` would find `guard.sh` inside `leak-guard.sh`
 * and report a guard as chained by a hook that never names it, and callers turn this answer into a
 * decision about whether to deliver a file.
 */
export function invokes(body: string, file: string): boolean {
	const escaped = file.replaceAll(/[$()*+.?[\\\]^{|}]/gu, '\\$&');
	return new RegExp(`(^|[^\\w.-])${escaped}([^\\w.-]|$)`, 'u').test(body);
}

/**
 * The files a group's own hook chains, read out of the hook body rather than declared beside it.
 *
 * The hook already states this and cannot be wrong about it: `.githooks/pre-commit` runs
 * leak-guard.sh and not leak-guard-setup.sh, which `prepare` runs instead. Both pre-commit variants
 * chain the same guard, so this is a property of the group rather than of the variant a particular
 * target receives — which of them a target actually runs is settled separately, against that
 * target's real dispatcher.
 */
export function chainedByHook(group: SharedCoreGroup, ownerRoot: string): Set<string> {
	if (group.hook === undefined) return new Set();
	const body = readFileSync(join(ownerRoot, group.sourceRoot, group.hook), 'utf8');
	const names = group.files
		.map((file) => file.target ?? file.source)
		.filter((name) => name !== group.hook && invokes(body, name));
	return new Set(names);
}

/**
 * Extensions that make a token a script somebody runs. `.json` and `.lock` are deliberately absent:
 * the canonical pre-commit greps for `bun\.lock` and `package\.json` to decide whether to run the
 * license check, and neither is a thing it invokes.
 */
const INVOKED = /[\w.-]+\.(?:bash|cjs|js|mjs|ps1|sh|ts)\b/gu;

/**
 * The script files a hook body invokes, by basename, with comment lines removed first.
 *
 * Basename rather than path because the two idioms in this fleet disagree about the path and agree
 * about the name: the canonical pre-commit writes `bash .githooks/leak-guard.sh` while pre-push
 * writes `bash "$hooks_dir/aidd-history-guard.sh"`, and a scan keyed on either spelling would miss
 * the other. Anything without one of the extensions above is not matched, so a hook chaining an
 * extensionless file is invisible here — an extensionless token cannot be told apart from `set` or
 * `echo`, and a scan that guessed would fail loads for words.
 *
 * Comments are stripped here and NOT in `chainedByHook`, which reads the same bodies. The two ask
 * different questions and a mention in a comment is the wrong answer in opposite directions: there
 * it makes a guard conditional on the target's dispatcher, which errs toward not delivering, while
 * here it would reject a manifest that describes reality correctly. The leak-guard-only pre-commit
 * names `install-leak-guard.ts` in its header for the reader's benefit and invokes nothing of the
 * sort.
 */
export function invokedScripts(body: string): Set<string> {
	const code = body
		.split('\n')
		.filter((line) => !/^\s*#/u.test(line))
		.join('\n');
	return new Set([...code.matchAll(INVOKED)].map((match) => match[0]));
}

/**
 * The body of the hook git will actually run for `hookName`, or null when nothing is dispatched.
 *
 * An unset core.hooksPath is not "no hooks" — it is git's default, `.git/hooks`, which is exactly
 * where a foreign dispatcher such as simple-git-hooks writes. Reading it is how a caller tells a
 * guard a target genuinely runs from one it merely holds a copy of.
 */
export function dispatcherBody(
	repoPath: string,
	configured: string,
	hookName: string,
): null | string {
	const dir = configured === '' ? join(repoPath, '.git', 'hooks') : resolve(repoPath, configured);
	const path = join(dir, hookName);
	return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
