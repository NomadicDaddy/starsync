import fs from 'node:fs';
import path from 'node:path';

import { runGit } from './git-exec.ts';

const WINDOWS_INVALID_CHARACTER = /[<>:"\\|?*]/;
const WINDOWS_PROTECTED_GIT_NAME = /^(?:\.git|git~1)$/i;
const WINDOWS_RESERVED_NAME = /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)(?:\..*)?$/i;
const SPARSE_PATTERN_METACHARACTER = /[*?[\]]/g;
const TREE_LISTING_BUFFER = 100 * 1024 * 1024;

/**
 * Disables the NTFS path guard for a single Git invocation.
 *
 * Git otherwise refuses to touch a tree containing a path it cannot represent
 * on this filesystem, which would fail the whole operation. It is only ever
 * paired with sparse-checkout exclusions that keep those paths out of the
 * working tree, so no unrepresentable path is written.
 */
export const PROTECT_NTFS_OVERRIDE = ['-c', 'core.protectNTFS=false'];

const hasWindowsControlCharacter = (component: string): boolean =>
	[...component].some((character) => character.charCodeAt(0) <= 31);

const isInvalidWindowsComponent = (component: string): boolean =>
	WINDOWS_INVALID_CHARACTER.test(component) ||
	/[ .]$/.test(component) ||
	hasWindowsControlCharacter(component) ||
	WINDOWS_PROTECTED_GIT_NAME.test(component) ||
	WINDOWS_RESERVED_NAME.test(component);

const isInvalidWindowsPath = (filePath: string): boolean =>
	filePath.split('/').some(isInvalidWindowsComponent);

/** True when this platform cannot represent the path in a working tree. */
const isUnrepresentablePath = (filePath: string): boolean =>
	process.platform === 'win32' && isInvalidWindowsPath(filePath);

/**
 * True when every reported path is one this platform cannot represent.
 *
 * An empty list is not unrepresentable state, so it returns false.
 */
export const areAllPathsUnrepresentable = (paths: string[]): boolean =>
	paths.length > 0 && paths.every(isUnrepresentablePath);

const listUnrepresentablePaths = async (checkoutPath: string): Promise<string[]> => {
	const output = await runGit(['ls-tree', '-r', '-z', '--name-only', 'HEAD'], {
		cwd: checkoutPath,
		maxBuffer: TREE_LISTING_BUFFER,
	});
	return output.split('\0').filter((filePath) => filePath && isUnrepresentablePath(filePath));
};

/**
 * Renders a path as a sparse-checkout pattern that matches only that path.
 *
 * Sparse patterns use gitignore syntax, which discards trailing spaces unless
 * each one is escaped. A path ending in a space is exactly the kind this
 * platform cannot represent, so leaving them unescaped would silently produce
 * a pattern that never matches the path it was written for.
 */
const escapeSparsePattern = (filePath: string): string =>
	filePath
		.replaceAll('\\', '\\\\')
		.replaceAll(SPARSE_PATTERN_METACHARACTER, (character) => `\\${character}`)
		.replace(/ +$/, (spaces) => spaces.replaceAll(' ', '\\ '));

const writeSparseExclusions = async (checkoutPath: string, paths: string[]): Promise<void> => {
	const patterns = ['/*', ...paths.map((filePath) => `!/${escapeSparsePattern(filePath)}`)];
	const relativePath = await runGit(['rev-parse', '--git-path', 'info/sparse-checkout'], {
		cwd: checkoutPath,
	});
	const sparsePath = path.resolve(checkoutPath, relativePath);
	fs.mkdirSync(path.dirname(sparsePath), { recursive: true });
	fs.writeFileSync(sparsePath, `${patterns.join('\n')}\n`, 'utf8');
	await runGit(['config', 'core.sparseCheckout', 'true'], { cwd: checkoutPath });
};

/**
 * Keeps paths this platform cannot represent out of the working tree while
 * leaving them in Git history and the index.
 *
 * The exclusion is recorded as a sparse checkout rather than as bare
 * skip-worktree bits, because a later fast-forward re-reads sparse patterns
 * and would otherwise try to write the unrepresentable path again and fail.
 * Returns false when the checkout has nothing to exclude.
 */
export const excludeUnrepresentablePaths = async (
	checkoutPath: string,
	env: NodeJS.ProcessEnv = {}
): Promise<boolean> => {
	const unrepresentable = await listUnrepresentablePaths(checkoutPath);
	if (unrepresentable.length === 0) return false;
	await writeSparseExclusions(checkoutPath, unrepresentable);
	await runGit([...PROTECT_NTFS_OVERRIDE, 'read-tree', '-mu', 'HEAD'], {
		cwd: checkoutPath,
		env,
	});
	return true;
};

/** True when Git refused an operation because a path is unrepresentable here. */
export const isUnrepresentablePathFailure = (err: unknown): boolean => {
	const message = err instanceof Error ? err.message : String(err);
	return (
		process.platform === 'win32' &&
		/invalid path|unable to checkout working tree|unable to create file/i.test(message)
	);
};

/** Populates the index and working tree of a checkout cloned with --no-checkout. */
export const materializeExcludedCheckout = async (
	checkoutPath: string,
	env: NodeJS.ProcessEnv = {}
): Promise<void> => {
	if (await excludeUnrepresentablePaths(checkoutPath, env)) return;
	await runGit([...PROTECT_NTFS_OVERRIDE, 'read-tree', '-mu', 'HEAD'], {
		cwd: checkoutPath,
		env,
	});
};
