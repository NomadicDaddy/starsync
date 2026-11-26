import type { ArchiveHost } from './archive-host.ts';

import { createRepositoryHost } from './repository-host.ts';
import { hasEmbeddedCredentials, isArchiveHostUrl, sanitizeUrl } from './secret-safety.ts';

export interface ResolvedRepository {
	id: number;
	name: string;
	owner: string;
	slug: string;
}

export type RepositoryResolver = (
	owner: string,
	repository: string,
	id?: number,
) => Promise<ResolvedRepository>;

export const parseGitHubRepositorySlug = (
	origin: string,
	host: ArchiveHost = 'github.com',
): { owner: string; repository: string } | null => {
	if (hasEmbeddedCredentials(origin)) return null;
	const sanitized = sanitizeUrl(origin);
	if (!isArchiveHostUrl(sanitized, host)) return null;
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

export const createGitHubRepositoryResolver = (
	token: string,
	host: ArchiveHost = 'github.com',
): RepositoryResolver => createRepositoryHost(host, token).resolve;
