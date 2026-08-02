import type { GitRecovery } from './git-recovery.ts';
import type { RefreshResult } from './refresh.ts';

import { readStatusPaths, runGit } from './git-exec.ts';
import { withGitRecovery } from './git-recovery.ts';
import { describeRetainedTags, fetchRemoteRefs } from './remote-fetch.ts';
import { isGitAuthError, sanitizeMessage, CREDENTIAL_GUIDANCE } from './secret-safety.ts';
import { areAllPathsUnrepresentable, excludeUnrepresentablePaths } from './windows-checkout.ts';

const blocked = (name: string, message: string): RefreshResult => ({
	message,
	name,
	outcome: 'blocked',
});

const failed = (name: string, err: unknown): RefreshResult => {
	const rawMessage = err instanceof Error ? err.message : String(err);
	const message = sanitizeMessage(rawMessage);
	return {
		message: isGitAuthError(rawMessage) ? `${message}\n${CREDENTIAL_GUIDANCE}` : message,
		name,
		outcome: 'failed',
	};
};

/**
 * Reports whether the checkout still holds local state after excluding paths
 * this platform cannot represent in a working tree.
 *
 * Git reports such a path as a pending deletion forever, because it can never
 * be materialized. Treating that as local work would block the checkout on
 * every refresh, so it is excluded from the working tree and re-inspected;
 * anything else remaining is genuine local state.
 */
const hasLocalState = async (repoPath: string): Promise<boolean> => {
	const paths = await readStatusPaths([], { cwd: repoPath });
	if (paths.length === 0) return false;
	if (!areAllPathsUnrepresentable(paths)) return true;
	if (!(await excludeUnrepresentablePaths(repoPath))) return true;
	return (await readStatusPaths([], { cwd: repoPath })).length > 0;
};

const resolveRemoteDefault = async (
	repoPath: string,
	name: string,
	defaultBranch: string
): Promise<{ hash: string; ref: string } | RefreshResult> => {
	const localRef = `refs/heads/${defaultBranch}`;
	try {
		if (defaultBranch.startsWith('-')) throw new Error('Leading dashes are not valid here.');
		await runGit(['check-ref-format', localRef], { cwd: repoPath });
	} catch {
		return blocked(
			name,
			`Remote default branch ${defaultBranch} is invalid — checkout blocked.`
		);
	}

	const remoteRef = `refs/remotes/origin/${defaultBranch}`;
	try {
		const hash = await runGit(['rev-parse', '--verify', `${remoteRef}^{commit}`], {
			cwd: repoPath,
		});
		return { hash, ref: remoteRef };
	} catch {
		return blocked(
			name,
			`Remote default branch origin/${defaultBranch} is unavailable — checkout blocked.`
		);
	}
};

const readLocalDefaultHash = async (
	repoPath: string,
	defaultBranch: string
): Promise<null | string> => {
	const localRef = `refs/heads/${defaultBranch}`;
	const branch = await runGit(['branch', '--list', '--format=%(refname)', '--', defaultBranch], {
		cwd: repoPath,
	});
	if (branch !== localRef) return null;
	return runGit(['rev-parse', '--verify', `${localRef}^{commit}`], { cwd: repoPath });
};

const createTrackingBranch = (
	repoPath: string,
	defaultBranch: string,
	remoteRef: string
): Promise<unknown> =>
	withGitRecovery(repoPath, (recovery: GitRecovery) =>
		runGit([...recovery.args, 'switch', '--create', defaultBranch, '--track', remoteRef], {
			cwd: repoPath,
			env: recovery.env,
		})
	);

const fastForwardToRemote = (
	repoPath: string,
	defaultBranch: string,
	remoteRef: null | string
): Promise<unknown> =>
	withGitRecovery(repoPath, async (recovery: GitRecovery) => {
		await runGit([...recovery.args, 'switch', defaultBranch], {
			cwd: repoPath,
			env: recovery.env,
		});
		if (remoteRef === null) return;
		await runGit([...recovery.args, 'merge', '--ff-only', remoteRef], {
			cwd: repoPath,
			env: recovery.env,
		});
	});

const advanceToRemoteDefault = async (
	repoPath: string,
	name: string,
	defaultBranch: string
): Promise<RefreshResult> => {
	const remote = await resolveRemoteDefault(repoPath, name, defaultBranch);
	if ('outcome' in remote) return remote;

	let localHash: null | string;
	try {
		localHash = await readLocalDefaultHash(repoPath, defaultBranch);
	} catch (err) {
		return failed(name, err);
	}

	if (localHash === null) {
		try {
			await createTrackingBranch(repoPath, defaultBranch, remote.ref);
			return { name, outcome: 'updated' };
		} catch (err) {
			return failed(name, err);
		}
	}

	if (localHash !== remote.hash) {
		try {
			await runGit(['merge-base', '--is-ancestor', localHash, remote.hash], {
				cwd: repoPath,
			});
		} catch {
			return blocked(
				name,
				'Local default branch and remote have diverged — checkout blocked to preserve local history.'
			);
		}
	}

	try {
		const isCurrent = localHash === remote.hash;
		await fastForwardToRemote(repoPath, defaultBranch, isCurrent ? null : remote.ref);
		return { name, outcome: isCurrent ? 'current' : 'updated' };
	} catch (err) {
		return failed(name, err);
	}
};

/**
 * Reports the tags a fetch left at their archived target.
 *
 * A result that already carries a message is left alone: a blocked or failed
 * refresh needs its own reason first, and the retained tags are reported again
 * by the next refresh that gets past it.
 */
const withRetainedTags = (result: RefreshResult, retainedTags: string[]): RefreshResult =>
	retainedTags.length === 0 || result.message !== undefined
		? result
		: { ...result, message: describeRetainedTags(retainedTags) };

export const refreshCheckoutOnDefaultBranch = async (
	repoPath: string,
	name: string,
	defaultBranch: string
): Promise<RefreshResult> => {
	let retainedTags: string[];
	try {
		retainedTags = await fetchRemoteRefs(repoPath);
	} catch (err) {
		return failed(name, err);
	}

	try {
		if (await hasLocalState(repoPath)) {
			return blocked(
				name,
				'Local changes detected — checkout blocked to preserve uncommitted work.'
			);
		}
	} catch (err) {
		return failed(name, err);
	}

	const result = await advanceToRemoteDefault(repoPath, name, defaultBranch);
	return withRetainedTags(result, retainedTags);
};
