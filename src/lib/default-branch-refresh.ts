import type { RefreshResult } from './refresh.ts';

import { isTransientGitError, runGit } from './git-exec.ts';
import { isGitAuthError, sanitizeMessage, CREDENTIAL_GUIDANCE } from './secret-safety.ts';

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

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

const fetchRemote = async (repoPath: string): Promise<void> => {
	await runGit(['fetch', '--tags', '--no-prune', 'origin'], {
		cwd: repoPath,
	});
};

const fetchRemoteWithRetry = async (
	repoPath: string,
	name: string
): Promise<null | RefreshResult> => {
	try {
		await fetchRemote(repoPath);
		return null;
	} catch (err) {
		if (
			!isTransientGitError(sanitizeMessage(err instanceof Error ? err.message : String(err)))
		) {
			return failed(name, err);
		}
		await sleep(1000);
		try {
			await fetchRemote(repoPath);
			return null;
		} catch (err) {
			return failed(name, err);
		}
	}
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

export const refreshCheckoutOnDefaultBranch = async (
	repoPath: string,
	name: string,
	defaultBranch: string
): Promise<RefreshResult> => {
	const fetchFailure = await fetchRemoteWithRetry(repoPath, name);
	if (fetchFailure !== null) return fetchFailure;

	let status: string;
	try {
		status = await runGit(['status', '--porcelain'], { cwd: repoPath });
	} catch (err) {
		return failed(name, err);
	}
	if (status.length > 0) {
		return blocked(
			name,
			'Local changes detected — checkout blocked to preserve uncommitted work.'
		);
	}

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
			await runGit(['switch', '--create', defaultBranch, '--track', remote.ref], {
				cwd: repoPath,
			});
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
		await runGit(['switch', defaultBranch], { cwd: repoPath });
		if (localHash === remote.hash) return { name, outcome: 'current' };
		await runGit(['merge', '--ff-only', remote.ref], {
			cwd: repoPath,
		});
		return { name, outcome: 'updated' };
	} catch (err) {
		return failed(name, err);
	}
};
