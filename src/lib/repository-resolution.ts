import { Octokit } from '@octokit/rest';

import { withApiRetry } from './api-retry.ts';
import { hasEmbeddedCredentials, isGitHubDotComUrl, sanitizeUrl } from './secret-safety.ts';

export interface ResolvedRepository {
	id: number;
	name: string;
	owner: string;
	slug: string;
}

export type RepositoryResolver = (owner: string, repository: string) => Promise<ResolvedRepository>;

export const parseGitHubRepositorySlug = (
	origin: string
): { owner: string; repository: string } | null => {
	if (hasEmbeddedCredentials(origin)) return null;
	const sanitized = sanitizeUrl(origin);
	if (!isGitHubDotComUrl(sanitized)) return null;
	let pathname: string;
	if (/^https?:\/\//i.test(sanitized) || /^ssh:\/\//i.test(sanitized)) {
		try {
			const parsed = new URL(sanitized);
			if (parsed.search || parsed.hash) return null;
			pathname = parsed.pathname;
		} catch {
			return null;
		}
	} else {
		const match = sanitized.match(/^git@[^:]+:(.+)$/i);
		if (!match?.[1]) return null;
		pathname = match[1];
	}
	const parts = pathname
		.replace(/^\/+/, '')
		.replace(/\.git$/i, '')
		.split('/')
		.filter(Boolean);
	return parts.length === 2 && parts[0] && parts[1]
		? { owner: parts[0], repository: parts[1] }
		: null;
};

export const createGitHubRepositoryResolver = (token: string): RepositoryResolver => {
	const octokit = new Octokit({ auth: token });
	return async (owner, repository) => {
		const response = await withApiRetry(
			() => octokit.rest.repos.get({ owner, repo: repository }),
			{ maxRetries: 2 }
		);
		return {
			id: response.data.id,
			name: response.data.name,
			owner: response.data.owner.login,
			slug: response.data.full_name,
		};
	};
};
