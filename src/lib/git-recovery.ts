import {
	excludeUnrepresentablePaths,
	isUnrepresentablePathFailure,
	PROTECT_NTFS_OVERRIDE,
} from './windows-checkout.ts';

const LFS_SMUDGE_FAILURE = /smudge filter lfs failed|smudge error|git-lfs filter-process' failed/i;
const MAX_RECOVERY_ATTEMPTS = 3;

/**
 * Git invocation adjustments that let an operation finish without changing
 * what the archive stores.
 */
export interface GitRecovery {
	args: string[];
	env: NodeJS.ProcessEnv;
}

export const NO_RECOVERY: GitRecovery = { args: [], env: {} };

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * True when Git produced a complete object database but Git LFS could not
 * resolve a pointer, which only upstream LFS storage decides.
 */
export const isLfsSmudgeFailure = (err: unknown): boolean =>
	LFS_SMUDGE_FAILURE.test(errorMessage(err));

export const withoutLfsContent = (recovery: GitRecovery): GitRecovery => ({
	...recovery,
	env: { ...recovery.env, GIT_LFS_SKIP_SMUDGE: '1' },
});

export const skipsLfsContent = (recovery: GitRecovery): boolean =>
	recovery.env.GIT_LFS_SKIP_SMUDGE !== undefined;

/**
 * Chooses the next recovery for a failed operation on an existing checkout,
 * or null when the failure is not one a retry can resolve.
 *
 * An unrepresentable path is excluded from the working tree before the retry;
 * an unavailable Git LFS object is left as its pointer. The message patterns
 * that identify an unrepresentable path also cover unrelated failures such as
 * an over-long path or a denied permission, so the retry is offered only when
 * the checkout actually holds a path this platform cannot represent.
 */
const planRecovery = async (
	checkoutPath: string,
	current: GitRecovery,
	err: unknown
): Promise<GitRecovery | null> => {
	if (isUnrepresentablePathFailure(err) && current.args.length === 0) {
		if (!(await excludeUnrepresentablePaths(checkoutPath, current.env))) return null;
		return { ...current, args: [...PROTECT_NTFS_OVERRIDE] };
	}
	if (isLfsSmudgeFailure(err) && !skipsLfsContent(current)) return withoutLfsContent(current);
	return null;
};

/**
 * Runs a Git operation, retrying it under a narrower recovery each time the
 * failure is one the archive tolerates. Each recovery is applied at most once,
 * so an operation that keeps failing surfaces its original error.
 */
export const withGitRecovery = async <T>(
	checkoutPath: string,
	run: (recovery: GitRecovery) => Promise<T>
): Promise<T> => {
	let recovery = NO_RECOVERY;
	for (let attempt = 0; attempt < MAX_RECOVERY_ATTEMPTS; attempt++) {
		try {
			return await run(recovery);
		} catch (err) {
			const next = await planRecovery(checkoutPath, recovery, err);
			if (next === null) throw err;
			recovery = next;
		}
	}
	throw new Error('Git recovery attempts were exhausted.');
};
