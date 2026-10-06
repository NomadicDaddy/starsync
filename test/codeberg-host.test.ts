import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { parseArchiveConfig } from '../src/lib/archive-config.ts';
import { parseInitHost } from '../src/lib/cli-host.ts';
import { createRepositoryHost } from '../src/lib/repository-host.ts';
import { parseGitHubRepositorySlug } from '../src/lib/repository-resolution.ts';

const repository = (id: number) => ({
	clone_url: `https://codeberg.org/example/repo-${id}.git`,
	default_branch: 'trunk',
	full_name: `example/repo-${id}`,
	id,
	name: `repo-${id}`,
});

let fetchMock: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;
const installFetch = (
	handler: (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => Promise<Response>,
): void => {
	fetchMock?.mockRestore();
	const replacement = Object.assign(handler, { preconnect: globalThis.fetch.preconnect });
	fetchMock = spyOn(globalThis, 'fetch').mockImplementation(replacement);
};
afterEach(() => {
	fetchMock?.mockRestore();
});

describe('Codeberg host contract', () => {
	test('follows short pages until exhaustion and resolves stable IDs', async () => {
		const routes: string[] = [];
		installFetch(async (input, init) => {
			const url = new URL(String(input));
			expect(url.origin).toBe('https://codeberg.org');
			expect(new Headers(init?.headers).get('Authorization')).toBe('token fixture-only');
			expect(init?.redirect).toBe('error');
			routes.push(url.pathname + url.search);
			if (url.pathname.endsWith('/user')) return Response.json({ id: 7, login: 'some_user' });
			if (url.pathname.includes('/repositories/')) return Response.json(repository(3));
			const page = Number(url.searchParams.get('page'));
			return Response.json(page < 3 ? [repository(page)] : []);
		});
		const host = createRepositoryHost('codeberg.org', 'fixture-only');
		expect(await host.authenticate()).toEqual({ id: 7, login: 'some_user' });
		expect((await host.listStars()).map((item) => item.id)).toEqual([1, 2]);
		expect(await host.resolve('old', 'gone', 3)).toEqual({
			id: 3,
			name: 'repo-3',
			owner: 'example',
			slug: 'example/repo-3',
		});
		expect(routes.at(-1)).toBe('/api/v1/repositories/3');
	});

	test('fails closed on repeated pagination and malformed responses', async () => {
		installFetch(async () => Response.json([repository(1)]));
		await expect(
			createRepositoryHost('codeberg.org', 'fixture-only').listStars(),
		).rejects.toThrow('pagination');
		installFetch(async () => Response.json({ error: 'not a list' }));
		await expect(
			createRepositoryHost('codeberg.org', 'fixture-only').listStars(),
		).rejects.toThrow('stars response');
	});

	test('never includes a failed API response body or credentials in errors', async () => {
		installFetch(async () => new Response('fixture-secret', { status: 401 }));
		await expect(
			createRepositoryHost('codeberg.org', 'fixture-secret').authenticate(),
		).rejects.toThrow('HTTP 401');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test('validates host config, CLI values and cross-host origins', () => {
		const owner = { id: 7, login: 'example' };
		expect(parseArchiveConfig({ archiveFormat: 2, owner })).toEqual({
			archiveFormat: 2,
			owner,
		});
		expect(parseArchiveConfig({ archiveFormat: 2, host: 'codeberg.org', owner }).host).toBe(
			'codeberg.org',
		);
		expect(() => parseArchiveConfig({ archiveFormat: 2, host: 'evil.test', owner })).toThrow();
		expect(parseInitHost(['--host', 'codeberg.org', 'archive']).host).toBe('codeberg.org');
		expect(parseInitHost(['--host=codeberg.org']).host).toBe('codeberg.org');
		for (const args of [
			['--host'],
			['--host='],
			['--host=codeberg.org', '--host=github.com'],
		]) {
			expect(() => parseInitHost(args)).toThrow();
		}
		expect(
			parseGitHubRepositorySlug('https://github.com/example/repo.git', 'codeberg.org'),
		).toBeNull();
		expect(
			parseGitHubRepositorySlug('git@codeberg.org:example/repo.git', 'codeberg.org'),
		).toEqual({ owner: 'example', repository: 'repo' });
	});
});
