import fs from 'node:fs';
import path from 'node:path';

import type { ProcessRepositoryOptions, RefreshResult, RepoRecord } from './refresh.ts';

import { finalizeCheckoutIdentity } from './checkout-state-transition.ts';
import { refreshCheckoutOnDefaultBranch } from './default-branch-refresh.ts';
import { checkoutGitBoundaryProblem } from './managed-checkout-inspection.ts';
import { buildRefreshFailure, cloneRepository } from './refresh-clone.ts';

const finalizeExistingIdentity = async (
	repo: RepoRecord,
	repoPath: string,
	result: RefreshResult,
): Promise<RefreshResult> => {
	if (
		repo.id === undefined ||
		repo.slug === undefined ||
		(result.outcome !== 'current' && result.outcome !== 'updated')
	) {
		return result;
	}
	const metadataError = await finalizeCheckoutIdentity(repoPath, {
		repositoryId: repo.id,
		repositorySlug: repo.slug,
	});
	return metadataError === null ? result : buildRefreshFailure(result.name, metadataError);
};

/**
 * Processes one repository without starting Git work after an interruption, or in an entry that
 * could send Git outside the archive. The boundary is checked again here, just before Git runs,
 * rather than trusted from the earlier archive scan.
 */
export const processRepository = async (
	repo: RepoRecord,
	targetBase: string,
	isInterruptionRequested: () => boolean,
	options: ProcessRepositoryOptions,
): Promise<RefreshResult> => {
	const folderName = repo.folderName ?? repo.name;
	const repoPath = path.join(targetBase, folderName);
	const boundaryProblem = await checkoutGitBoundaryProblem(targetBase, folderName);
	const hasGitDir = fs.existsSync(repoPath) && fs.existsSync(path.join(repoPath, '.git'));
	let result: RefreshResult;
	if (isInterruptionRequested()) {
		result = {
			message: 'Interrupted before Git work could start.',
			name: folderName,
			outcome: 'skipped',
		};
	} else if (boundaryProblem !== null) {
		result = buildRefreshFailure(folderName, boundaryProblem);
	} else if (!hasGitDir) {
		result = await cloneRepository(repo, targetBase, options);
	} else {
		result = await refreshCheckoutOnDefaultBranch(repoPath, folderName, repo.defaultBranch);
	}
	const finalized = await finalizeExistingIdentity(repo, repoPath, result);
	return { ...finalized, pendingRename: repo.pendingRename ?? false };
};
