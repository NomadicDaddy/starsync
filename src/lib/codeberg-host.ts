import type { ArchiveOwner } from './archive-config.ts';
import type { StarredRepositoryRecord } from './managed-checkout-planning.ts';
import type { RepositoryHost } from './repository-host.ts';

import { withApiRetry } from './api-retry.ts';

const record = (value: unknown): Record<string, unknown> => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('Invalid Codeberg API response.');
	}
	return value as Record<string, unknown>;
};

const positiveId = (value: unknown): number => {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error('Codeberg returned an invalid identity.');
	}
	return value;
};

const stringField = (value: unknown): string => {
	if (typeof value !== 'string' || !value) throw new Error('Invalid Codeberg response field.');
	return value;
};

const parseOwner = (value: unknown): ArchiveOwner => {
	const owner = record(value);
	return { id: positiveId(owner.id), login: stringField(owner.login) };
};

const parseRepository = (value: unknown): StarredRepositoryRecord => {
	const repository = record(value);
	return {
		clone_url: stringField(repository.clone_url),
		defaultBranch: stringField(repository.default_branch),
		id: positiveId(repository.id),
		name: stringField(repository.name),
		slug: stringField(repository.full_name),
	};
};

const request = (token: string, route: string): Promise<Response> =>
	withApiRetry(
		async () => {
			const response = await fetch(`https://codeberg.org/api/v1/${route}`, {
				headers: { Accept: 'application/json', Authorization: `token ${token}` },
				redirect: 'error',
				signal: AbortSignal.timeout(30_000),
			});
			if (!response.ok) {
				throw Object.assign(
					new Error(`Codeberg API request failed (HTTP ${response.status}).`),
					{
						response: { headers: Object.fromEntries(response.headers) },
						status: response.status,
					},
				);
			}
			return response;
		},
		{ maxRetries: 2 },
	);

const listStars = async (token: string): Promise<StarredRepositoryRecord[]> => {
	const repositories: StarredRepositoryRecord[] = [];
	const seen = new Set<number>();
	for (let page = 1; ; page++) {
		const response = await request(token, `user/starred?limit=50&page=${page}`);
		const body: unknown = await response.json();
		if (!Array.isArray(body)) throw new Error('Invalid Codeberg stars response.');
		if (body.length === 0) return repositories;
		for (const value of body) {
			const repository = parseRepository(value);
			if (seen.has(repository.id))
				throw new Error('Codeberg stars changed during pagination; retry.');
			seen.add(repository.id);
			repositories.push(repository);
		}
	}
};

export const createCodebergHost = (token: string): RepositoryHost => ({
	authenticate: async () => parseOwner(await (await request(token, 'user')).json()),
	listStars: () => listStars(token),
	resolve: async (owner, repository, id) => {
		const route =
			id === undefined
				? `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`
				: `repositories/${id}`;
		const resolved = parseRepository(await (await request(token, route)).json());
		return {
			id: resolved.id,
			name: resolved.name,
			owner: resolved.slug.split('/')[0]!,
			slug: resolved.slug,
		};
	},
});
