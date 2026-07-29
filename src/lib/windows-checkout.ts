import fs from 'node:fs';
import path from 'node:path';

import { runGit } from './git-exec.ts';

const WINDOWS_INVALID_CHARACTER = /[<>:"\\|?*]/;
const WINDOWS_PROTECTED_GIT_NAME = /^(?:\.git|git~1)$/i;
const WINDOWS_RESERVED_NAME = /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)(?:\..*)?$/i;
const STAGED_CHECKOUT_PREFIX = '.starsync-checkout-';

const hasWindowsControlCharacter = (component: string): boolean =>
	[...component].some((character) => character.charCodeAt(0) <= 31);

const isInvalidWindowsComponent = (component: string): boolean =>
	WINDOWS_INVALID_CHARACTER.test(component) ||
	/[ .]$/.test(component) ||
	hasWindowsControlCharacter(component) ||
	WINDOWS_PROTECTED_GIT_NAME.test(component) ||
	WINDOWS_RESERVED_NAME.test(component);

export const isInvalidWindowsPath = (filePath: string): boolean =>
	filePath.split('/').some(isInvalidWindowsComponent);

const listInvalidWindowsPaths = async (checkoutPath: string): Promise<string[]> => {
	const output = await runGit(['ls-tree', '-r', '-z', '--name-only', 'HEAD'], {
		cwd: checkoutPath,
		maxBuffer: 100 * 1024 * 1024,
	});
	return output.split('\0').filter((filePath) => filePath && isInvalidWindowsPath(filePath));
};

const materializeWindowsCheckout = async (checkoutPath: string): Promise<void> => {
	const invalidPaths = await listInvalidWindowsPaths(checkoutPath);
	await runGit(['config', 'core.protectNTFS', 'false'], { cwd: checkoutPath });
	try {
		await runGit(['read-tree', 'HEAD'], { cwd: checkoutPath });
		for (const invalidPath of invalidPaths) {
			await runGit(['update-index', '--skip-worktree', '--', invalidPath], {
				cwd: checkoutPath,
			});
		}
		await runGit(['checkout-index', '--all'], { cwd: checkoutPath });
	} finally {
		await runGit(['config', '--unset', 'core.protectNTFS'], { cwd: checkoutPath });
	}
};

const isWindowsPathCheckoutFailure = (err: unknown): boolean => {
	const message = err instanceof Error ? err.message : String(err);
	return /invalid path|unable to checkout working tree/i.test(message);
};

const resetOwnedStagingDirectory = (targetBase: string, stagingName: string): void => {
	const resolvedTarget = path.resolve(targetBase);
	const stagingPath = path.resolve(targetBase, stagingName);
	if (
		path.dirname(stagingPath) !== resolvedTarget ||
		!path.basename(stagingPath).startsWith(STAGED_CHECKOUT_PREFIX)
	) {
		throw new Error('Refusing to reset a directory that StarSync does not own.');
	}
	fs.rmSync(stagingPath, { force: true, recursive: true });
	fs.mkdirSync(stagingPath);
};

export const cloneRepositoryForCurrentPlatform = async (
	cloneUrl: string,
	stagingName: string,
	targetBase: string
): Promise<void> => {
	try {
		await runGit(['clone', cloneUrl, stagingName], { cwd: targetBase });
		return;
	} catch (err) {
		if (process.platform !== 'win32' || !isWindowsPathCheckoutFailure(err)) throw err;
	}
	resetOwnedStagingDirectory(targetBase, stagingName);
	await runGit(['clone', '--no-checkout', cloneUrl, stagingName], { cwd: targetBase });
	await materializeWindowsCheckout(path.join(targetBase, stagingName));
};
