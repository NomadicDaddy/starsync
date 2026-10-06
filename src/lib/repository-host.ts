import { Octokit } from '@octokit/rest';

import type { ArchiveOwner } from './archive-config.ts';
import type { ArchiveHost } from './archive-host.ts';
import type { StarredRepositoryRecord } from './managed-checkout-planning.ts';
import type { ResolvedRepository } from './repository-resolution.ts';

import { withApiRetry } from './api-retry.ts';
import { createCodebergHost } from './codeberg-host.ts';

export interface RepositoryHost {
	authenticate: () => Promise<ArchiveOwner>;
	listStars: () => Promise<StarredRepositoryRecord[]>;
	resolve: (owner: string, repository: string, id?: number) => Promise<ResolvedRepository>;
}

const createGitHubHost = (token: string): RepositoryHost => {
	const octokit = new Octokit({ auth: token });
	return {
		authenticate: async () => {
			const { data } = await withApiRetry(() => octokit.rest.users.getAuthenticated(), {
				maxRetries: 2,
			});
			return { id: data.id, login: data.login };
		},
		listStars: async () => {
			const repositories = await withApiRetry(
				() =>
					octokit.paginate(octokit.rest.activity.listReposStarredByAuthenticatedUser, {
						per_page: 100,
					}),
				{ maxRetries: 2 },
			);
			return repositories.map((repository) => ({
				clone_url: repository.clone_url,
				defaultBranch: repository.default_branch,
				id: repository.id,
				name: repository.name,
				slug: repository.full_name,
			}));
		},
		resolve: async (owner, repository, id) => {
			const { data } = await withApiRetry(
				() =>
					id === undefined
						? octokit.rest.repos.get({ owner, repo: repository })
						: octokit.request('GET /repositories/{repository_id}', {
								repository_id: id,
							}),
				{ maxRetries: 2 },
			);
			return { id: data.id, name: data.name, owner: data.owner.login, slug: data.full_name };
		},
	};
};

export const createRepositoryHost = (host: ArchiveHost, token: string): RepositoryHost =>
	host === 'codeberg.org' ? createCodebergHost(token) : createGitHubHost(token);
