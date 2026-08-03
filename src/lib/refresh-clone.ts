import type { ProcessRepositoryOptions, RefreshResult, RepoRecord } from './refresh.ts';

import { CREDENTIAL_GUIDANCE, isGitAuthError, sanitizeMessage } from './secret-safety.ts';
import { createStagedCheckout } from './staged-checkout.ts';

export const buildRefreshFailure = (name: string, err: unknown): RefreshResult => {
	const rawMessage = err instanceof Error ? err.message : String(err);
	const sanitized = sanitizeMessage(rawMessage);
	const message = isGitAuthError(rawMessage) ? `${sanitized}\n${CREDENTIAL_GUIDANCE}` : sanitized;
	return { message, name, outcome: 'failed' };
};

/** Clones, validates, and atomically publishes a new managed checkout. */
export const cloneRepository = async (
	repo: RepoRecord,
	targetBase: string,
	options: ProcessRepositoryOptions,
): Promise<RefreshResult> => {
	const folderName = repo.folderName ?? repo.name;
	try {
		if (repo.id === undefined || repo.slug === undefined) {
			throw new Error('New managed checkout is missing its stable repository identity.');
		}
		await createStagedCheckout(
			{
				cloneUrl: repo.clone_url,
				folderName,
				repositoryId: repo.id,
				repositorySlug: repo.slug,
			},
			targetBase,
			options,
		);
		return { name: folderName, outcome: 'added' };
	} catch (err) {
		return buildRefreshFailure(folderName, err);
	}
};
