import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { initArchive, renameArchive, syncArchive, verifyArchive } from '../../src/index.ts';
import { createRealRefreshFixture, runRealGit } from './refresh-fixture.ts';

test('Codeberg archive clones, refreshes, renames by ID, repairs and rejects foreign origins', async () => {
	const root = mkdtempSync(path.join(tmpdir(), 'starsync-codeberg-'));
	const fixture = createRealRefreshFixture(root);
	const target = path.join(root, 'codeberg');
	mkdirSync(target);
	const config = path.join(process.env.USERPROFILE!, '.gitconfig');
	writeFileSync(
		config,
		`[url "${pathToFileURL(fixture.origin).href}"]\n\tinsteadOf = https://codeberg.org/example/repository.git\n\tinsteadOf = https://codeberg.org/example/renamed.git\n`,
	);
	let slug = 'example/repository';
	let ownerId = 7;
	const routes: string[] = [];
	const handler = async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
		const url = new URL(String(input));
		expect(url.origin).toBe('https://codeberg.org');
		routes.push(url.pathname);
		if (url.pathname.endsWith('/user')) return Response.json({ id: ownerId, login: 'example' });
		const repository = {
			clone_url: `https://codeberg.org/${slug}.git`,
			default_branch: 'main',
			full_name: slug,
			id: 321,
			name: slug.split('/')[1],
		};
		if (url.pathname.endsWith('/user/starred'))
			return Response.json(url.searchParams.get('page') === '1' ? [repository] : []);
		return Response.json(repository);
	};
	const mocked = spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(handler, { preconnect: globalThis.fetch.preconnect }),
	);
	try {
		expect(
			(await initArchive({ host: 'codeberg.org', targetPath: target, token: 'fixture-only' }))
				.exitCode,
		).toBe(0);
		expect(
			JSON.parse(readFileSync(path.join(target, '.starsync/config.json'), 'utf8')).host,
		).toBe('codeberg.org');
		const options = { minFreeSpace: 0, targetPath: target, token: 'fixture-only' };
		const added = await syncArchive(options);
		expect(added.exitCode).toBe(0);
		expect(added.checkouts[0]?.outcome).toBe('added');
		expect((await syncArchive(options)).exitCode).toBe(0);
		expect((await verifyArchive({ targetPath: target })).exitCode).toBe(0);
		slug = 'example/renamed';
		const renamed = await renameArchive({ ...options, apply: true });
		expect(renamed.exitCode).toBe(0);
		expect(routes).toContain('/api/v1/repositories/321');
		const checkout = path.join(target, 'renamed--example');
		expect(existsSync(checkout)).toBe(true);
		expect(runRealGit(['config', '--get', 'remote.origin.url'], checkout)).toBe(
			'https://codeberg.org/example/renamed.git',
		);
		writeFileSync(path.join(checkout, 'README.md'), 'local fixture change');
		expect((await verifyArchive({ ...options, force: true })).exitCode).toBe(0);
		expect(readFileSync(path.join(checkout, 'README.md'), 'utf8').trim()).toBe('# repository');
		ownerId = 8;
		expect(
			(await syncArchive(options)).findings.some(
				(finding) => finding.code === 'archive-owner-mismatch',
			),
		).toBe(true);
		ownerId = 7;
		runRealGit(
			['remote', 'set-url', 'origin', 'https://github.com/example/renamed.git'],
			checkout,
		);
		expect((await verifyArchive({ targetPath: target })).exitCode).toBe(1);
		expect((await syncArchive({ ...options, dryRun: true })).exitCode).toBe(1);
		expect((await renameArchive(options)).exitCode).toBe(1);
		writeFileSync(path.join(checkout, 'README.md'), 'preserve foreign checkout');
		expect((await verifyArchive({ ...options, force: true })).exitCode).toBe(1);
		expect(readFileSync(path.join(checkout, 'README.md'), 'utf8')).toBe(
			'preserve foreign checkout',
		);
	} finally {
		mocked.mockRestore();
		rmSync(root, { force: true, recursive: true });
	}
});
