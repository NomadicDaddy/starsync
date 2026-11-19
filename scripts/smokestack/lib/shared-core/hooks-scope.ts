/**
 * Which `core.hooksPath` git dispatches from in one checkout, and where a write to it lands.
 *
 * A linked worktree shares its repository's config file unless `extensions.worktreeConfig` is on.
 * With it on, each checkout can keep its own value in its config.worktree, and git dispatches from
 * that value first, then the shared one. So a reader that asks `git config --local` alone would see
 * the canonical checkout's value while git ran the worktree's, and a writer using `--local` would
 * change every checkout at once (hook-readers-honour-worktree-scoped-hookspath, with Spernakit's
 * worktree-prepare-shared-hook-path: one contract, option W, Edgar #58483).
 *
 * With the extension off, both answers are exactly today's: `--local`. Global config is left out,
 * as every hooks-path reader here always has.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */

function gitConfig(root: string, args: string[]): { code: number; out: string } {
	const result = Bun.spawnSync(['git', '-C', root, 'config', ...args], {
		stderr: 'pipe',
		stdout: 'pipe',
		windowsHide: true,
	});
	return { code: result.exitCode ?? -1, out: result.stdout.toString().trim() };
}

/** The scope that keeps `core.hooksPath` to `root` alone where git allows it. */
export function hooksConfigFlag(root: string): '--local' | '--worktree' {
	const on = gitConfig(root, ['--bool', '--get', 'extensions.worktreeConfig']).out;
	return on === 'true' ? '--worktree' : '--local';
}

/**
 * True when `root` is a linked worktree, not its repository's main checkout: git keeps a linked
 * worktree's own git directory apart from the common one. Both paths come from git in the same
 * form, so comparing them is not comparing two spellings of one path.
 */
export function isLinkedWorktree(root: string): boolean {
	const result = Bun.spawnSync(
		['git', '-C', root, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
		{ stderr: 'pipe', stdout: 'pipe', windowsHide: true },
	);
	if (result.exitCode !== 0) return false;
	const [gitDir, commonDir] = result.stdout.toString().trim().split(/\r?\n/u);
	return gitDir !== undefined && commonDir !== undefined && gitDir !== commonDir;
}

/**
 * The hooks path git uses for `root` from repository config: the checkout's own value under
 * worktree config, else the shared one. A value only in the shared config, such as another tool's,
 * still counts with worktree config on. An empty string means unset.
 */
export function effectiveHooksPath(root: string): string {
	const flag = hooksConfigFlag(root);
	const own = gitConfig(root, [flag, '--get', 'core.hooksPath']).out;
	if (own !== '' || flag === '--local') return own;
	return gitConfig(root, ['--local', '--get', 'core.hooksPath']).out;
}
