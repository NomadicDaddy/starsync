import fs from 'node:fs';
import path from 'node:path';

import type { GitRecovery } from './git-recovery.ts';

import { runGit } from './git-exec.ts';
import {
	isLfsSmudgeFailure,
	NO_RECOVERY,
	skipsLfsContent,
	withoutLfsContent,
} from './git-recovery.ts';
import { isOwnedStagingCheckoutName } from './owned-checkout-artifacts.ts';
import { isUnrepresentablePathFailure, materializeExcludedCheckout } from './windows-checkout.ts';

const MAX_CLONE_ATTEMPTS = 3;

const resetOwnedStagingDirectory = (targetBase: string, stagingName: string): void => {
	const resolvedTarget = path.resolve(targetBase);
	const stagingPath = path.resolve(targetBase, stagingName);
	if (
		path.dirname(stagingPath) !== resolvedTarget ||
		!isOwnedStagingCheckoutName(path.basename(stagingPath))
	) {
		throw new Error('Refusing to reset a directory that StarSync does not own.');
	}
	fs.rmSync(stagingPath, { force: true, recursive: true });
	fs.mkdirSync(stagingPath);
};

const runClone = async (
	cloneUrl: string,
	stagingName: string,
	targetBase: string,
	recovery: GitRecovery,
	excludeUnrepresentable: boolean,
): Promise<void> => {
	if (!excludeUnrepresentable) {
		await runGit(['clone', cloneUrl, stagingName], { cwd: targetBase, env: recovery.env });
		return;
	}
	await runGit(['clone', '--no-checkout', cloneUrl, stagingName], {
		cwd: targetBase,
		env: recovery.env,
	});
	await materializeExcludedCheckout(path.join(targetBase, stagingName), recovery.env);
};

/**
 * Clones a repository into a StarSync-owned staging directory.
 *
 * An ordinary clone is attempted first. It falls back only for the two
 * conditions that make one impossible without changing what the archive
 * stores: a path this platform cannot represent in a working tree, and a Git
 * LFS object upstream no longer serves. Each fallback is applied at most once,
 * and every attempt starts from an empty staging directory so no partial
 * clone is ever published.
 */
export const cloneManagedCheckout = async (
	cloneUrl: string,
	stagingName: string,
	targetBase: string,
): Promise<void> => {
	let recovery = NO_RECOVERY;
	let excludeUnrepresentable = false;
	for (let attempt = 0; attempt < MAX_CLONE_ATTEMPTS; attempt++) {
		try {
			await runClone(cloneUrl, stagingName, targetBase, recovery, excludeUnrepresentable);
			return;
		} catch (err) {
			if (isUnrepresentablePathFailure(err) && !excludeUnrepresentable) {
				excludeUnrepresentable = true;
			} else if (isLfsSmudgeFailure(err) && !skipsLfsContent(recovery)) {
				recovery = withoutLfsContent(recovery);
			} else {
				throw err;
			}
			resetOwnedStagingDirectory(targetBase, stagingName);
		}
	}
	throw new Error('Clone recovery attempts were exhausted.');
};
