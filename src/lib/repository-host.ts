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

const errorField = (value: unknown, key: string): unknown =>
	typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)[key]
		: undefined;

const responseStatus = (err: unknown): number | undefined => {
	const status = errorField(err, 'status');
	return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
};

const rateLimitNote = (err: unknown): string => {
	const headers = errorField(errorField(err, 'response'), 'headers');
	if (errorField(headers, 'x-ratelimit-remaining') !== '0') return '';
	const reset = Number(errorField(headers, 'x-ratelimit-reset'));
	return Number.isSafeInteger(reset) && reset > 0
		? ` The rate limit is exhausted until ${new Date(reset * 1000).toISOString()}.`
		: ' The rate limit is exhausted.';
};

/**
 * Runs one GitHub API call under the shared retry policy, then replaces any failure with a message
 * built only from the operation, the HTTP status and the rate-limit reset. Octokit's own message
 * can carry the response body, which may echo the request's credentials, so none of it leaves the
 * adapter. The status stays on the error, as it does on the Codeberg adapter's errors.
 */
const githubRequest = async <T>(operation: string, call: () => Promise<T>): Promise<T> => {
	try {
		return await withApiRetry(call, { maxRetries: 2 });
	} catch (err) {
		const status = responseStatus(err);
		const reached = status === undefined ? '' : ` (HTTP ${status})`;
		throw Object.assign(
			new Error(
				`GitHub API request failed${reached} while ${operation}.${rateLimitNote(err)}`,
			),
			status === undefined ? {} : { status },
		);
	}
};

const createGitHubHost = (token: string): RepositoryHost => {
	const octokit = new Octokit({ auth: token });
	return {
		authenticate: async () => {
			const { data } = await githubRequest('reading the authenticated account', () =>
				octokit.rest.users.getAuthenticated(),
			);
			return { id: data.id, login: data.login };
		},
		listStars: async () => {
			const repositories = await githubRequest('listing starred repositories', () =>
				octokit.paginate(octokit.rest.activity.listReposStarredByAuthenticatedUser, {
					per_page: 100,
				}),
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
			const { data } = await githubRequest(
				id === undefined
					? `resolving ${owner}/${repository}`
					: `resolving repository ${id}`,
				() =>
					id === undefined
						? octokit.rest.repos.get({ owner, repo: repository })
						: octokit.request('GET /repositories/{repository_id}', {
								repository_id: id,
							}),
			);
			return { id: data.id, name: data.name, owner: data.owner.login, slug: data.full_name };
		},
	};
};

export const createRepositoryHost = (host: ArchiveHost, token: string): RepositoryHost =>
	host === 'codeberg.org' ? createCodebergHost(token) : createGitHubHost(token);
