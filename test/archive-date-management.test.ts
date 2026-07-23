import { describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CommandReport } from '../src/lib/reporting.ts';

import { normalizeArchiveDates } from '../src/index.ts';

const projectRoot = path.resolve(import.meta.dir, '..');
const newestCommitTime = new Date('2026-07-20T16:30:00Z');

const run = (
	command: string[],
	cwd = projectRoot,
	env: NodeJS.ProcessEnv = process.env
): string => {
	const result = Bun.spawnSync({
		cmd: command,
		cwd,
		env,
		stderr: 'pipe',
		stdout: 'pipe',
	});
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.toString() || result.stdout.toString());
	}
	return result.stdout.toString().trim();
};

const commit = (checkout: string, message: string, timestamp: string): void => {
	run(['git', 'add', '.'], checkout);
	run(['git', 'commit', '--quiet', '-m', message], checkout, {
		...process.env,
		GIT_AUTHOR_DATE: timestamp,
		GIT_COMMITTER_DATE: timestamp,
	});
};

const createCheckout = (
	root: string,
	name: string,
	identity: { id: number; slug: string } | null
): string => {
	const checkout = path.join(root, name);
	mkdirSync(checkout);
	run(['git', 'init', '--quiet', '--initial-branch=main'], checkout);
	run(['git', 'config', 'user.name', 'StarSync Test'], checkout);
	run(['git', 'config', 'user.email', 'starsync@example.invalid'], checkout);
	writeFileSync(path.join(checkout, 'README.md'), '# initial\n');
	commit(checkout, 'initial', '2026-07-10T09:00:00Z');
	run(['git', 'checkout', '--quiet', '-b', 'archive/newer'], checkout);
	writeFileSync(path.join(checkout, 'newer.txt'), 'newer history\n');
	commit(checkout, 'newer history', newestCommitTime.toISOString());
	writeFileSync(path.join(checkout, 'clock-skew.txt'), 'older timestamp on a newer commit\n');
	commit(checkout, 'clock-skewed branch tip', '2026-07-15T12:00:00Z');
	run(['git', 'checkout', '--quiet', 'main'], checkout);

	const slug = identity?.slug ?? `owner/${name}`;
	run(['git', 'remote', 'add', 'origin', `https://github.com/${slug}.git`], checkout);
	if (identity !== null) {
		run(['git', 'config', 'starsync.repository-id', String(identity.id)], checkout);
		run(['git', 'config', 'starsync.repository-slug', identity.slug], checkout);
	}
	return checkout;
};

const writeArchiveConfig = (root: string): void => {
	mkdirSync(path.join(root, '.starsync'));
	writeFileSync(
		path.join(root, '.starsync', 'config.json'),
		JSON.stringify({
			archiveFormat: 2,
			owner: { id: 7, login: 'archive-owner' },
		})
	);
};

const runDatesCli = (
	target: string,
	...options: string[]
): { report: CommandReport; status: number; stderr: string } => {
	const result = Bun.spawnSync({
		cmd: [process.execPath, 'src/cli.ts', 'dates', '--json', ...options, target],
		cwd: projectRoot,
		env: { ...process.env, GITHUB_TOKEN: '' },
		stderr: 'pipe',
		stdout: 'pipe',
	});
	return {
		report: JSON.parse(result.stdout.toString()) as CommandReport,
		status: result.exitCode,
		stderr: result.stderr.toString(),
	};
};

describe('managed Archive Dates process boundary', () => {
	test('previews and repairs from the newest committer time across every local ref', async () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-dates-managed-'));
		try {
			const checkout = createCheckout(target, 'repo--owner', {
				id: 101,
				slug: 'owner/repo',
			});
			writeArchiveConfig(target);
			const driftedTime = new Date('2030-01-01T00:00:00Z');
			utimesSync(checkout, driftedTime, driftedTime);

			expect(run(['git', 'log', '-1', '--format=%cI'], checkout)).toContain(
				'2026-07-10T09:00:00'
			);
			expect(run(['git', 'log', '--all', '-1', '--format=%cI'], checkout)).toContain(
				'2026-07-15T12:00:00'
			);

			const preview = await normalizeArchiveDates({ dryRun: true, targetPath: target });

			expect(preview).toMatchObject({ exitCode: 0 });
			expect(preview.checkouts[0]).toEqual(
				expect.objectContaining({
					name: 'repo--owner',
					outcome: 'skipped',
					plannedOutcome: 'updated',
				})
			);
			expect(preview.checkouts[0]?.findings).toContainEqual(
				expect.objectContaining({ code: 'date-update-planned' })
			);
			expect(statSync(checkout).mtimeMs).toBe(driftedTime.getTime());

			const applied = runDatesCli(target);

			expect(applied.status).toBe(0);
			expect(applied.report.exitCode).toBe(0);
			expect(applied.report.checkouts[0]?.outcome).toBe('updated');
			expect(Math.abs(statSync(checkout).mtimeMs - newestCommitTime.getTime())).toBeLessThan(
				1_000
			);
			expect(applied.stderr).not.toContain('GITHUB_TOKEN');

			const current = await normalizeArchiveDates({ targetPath: target });
			expect(current.exitCode).toBe(0);
			expect(current.checkouts[0]?.outcome).toBe('current');
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('normalizes recognized checkouts without changing unrelated archive entries', async () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-dates-recognized-'));
		try {
			const managed = createCheckout(target, 'managed--owner', {
				id: 202,
				slug: 'owner/managed',
			});
			const unidentified = createCheckout(target, 'unidentified', null);
			const unrelated = path.join(target, 'notes');
			mkdirSync(unrelated);
			writeFileSync(path.join(unrelated, 'README.txt'), 'leave this folder alone\n');
			writeArchiveConfig(target);

			const driftedTime = new Date('2030-01-01T00:00:00Z');
			utimesSync(managed, driftedTime, driftedTime);
			utimesSync(unidentified, driftedTime, driftedTime);
			utimesSync(unrelated, driftedTime, driftedTime);
			const unidentifiedConfig = readFileSync(
				path.join(unidentified, '.git', 'config'),
				'utf-8'
			);

			const report = await normalizeArchiveDates({ targetPath: target });

			expect(report).toMatchObject({ exitCode: 1 });
			expect(Math.abs(statSync(managed).mtimeMs - newestCommitTime.getTime())).toBeLessThan(
				1_000
			);
			expect(statSync(unidentified).mtimeMs).toBe(driftedTime.getTime());
			expect(statSync(unrelated).mtimeMs).toBe(driftedTime.getTime());
			expect(readFileSync(path.join(unidentified, '.git', 'config'), 'utf-8')).toBe(
				unidentifiedConfig
			);
			expect(
				report.checkouts.some(
					(checkout) =>
						checkout.name === 'unidentified' &&
						checkout.findings.some(
							(finding) => finding.code === 'missing-identity-metadata'
						)
				)
			).toBe(true);
			expect(
				report.checkouts.some(
					(checkout) =>
						checkout.name === 'notes' &&
						checkout.findings.some((finding) => finding.code === 'not-git-checkout')
				)
			).toBe(true);
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});
});
