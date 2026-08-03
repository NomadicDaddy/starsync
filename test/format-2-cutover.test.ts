import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as publicApi from '../src/index.ts';
import { inspectArchive } from '../src/lib/archive-inspection.ts';
import { createCommandReport, createFinding } from '../src/lib/reporting.ts';

const projectRoot = path.resolve(import.meta.dir, '..');

const writeConfig = (target: string, config: unknown): void => {
	mkdirSync(path.join(target, '.starsync'));
	writeFileSync(path.join(target, '.starsync', 'config.json'), JSON.stringify(config));
};

const runCli = (args: string[]) =>
	Bun.spawnSync({
		cmd: [process.execPath, 'src/cli.ts', ...args],
		cwd: projectRoot,
		env: { ...process.env, GITHUB_TOKEN: '', TARGET_PATH: '' },
		stderr: 'pipe',
		stdout: 'pipe',
	});

describe('format-2 archive cutover', () => {
	test('treats empty and populated configless directories as uninitialized', () => {
		for (const populated of [false, true]) {
			const target = mkdtempSync(path.join(tmpdir(), 'starsync-configless-'));
			try {
				if (populated) writeFileSync(path.join(target, 'existing.txt'), 'preserve me');
				const inspection = inspectArchive(target);
				expect(inspection.kind).toBe('uninitialized');
				expect(inspection.entries).toEqual([]);
				expect(inspection.findings[0]?.code).toBe('archive-uninitialized');
				expect(inspection.findings[0]?.message).toContain(
					populated
						? 'rebuild the archive in a different empty directory'
						: 'starsync init',
				);
			} finally {
				rmSync(target, { force: true, recursive: true });
			}
		}
	});

	test('rejects every non-current format and malformed format-2 config', () => {
		const cases = [
			[{ archiveFormat: 1, owner: { id: 7, login: 'owner' } }, 'unsupported'],
			[{ archiveFormat: 3, owner: { id: 7, login: 'owner' } }, 'unsupported'],
			[{ archiveFormat: 2, owner: null }, 'invalid'],
			[{ archiveFormat: 2, owner: { id: 7, login: 'invalid--owner' } }, 'invalid'],
			[{ archiveFormat: 2, owner: { id: 7, login: 'a'.repeat(40) } }, 'invalid'],
			[{ archiveFormat: 2, extra: true, owner: { id: 7, login: 'owner' } }, 'invalid'],
		] as const;
		for (const [config, expectedKind] of cases) {
			const target = mkdtempSync(path.join(tmpdir(), 'starsync-invalid-format-'));
			try {
				writeConfig(target, config);
				expect(inspectArchive(target).kind).toBe(expectedKind);
			} finally {
				rmSync(target, { force: true, recursive: true });
			}
		}
	});
});

describe('explicit CLI cutover', () => {
	test('rejects bare and retired command invocation without touching the target', () => {
		const target = mkdtempSync(path.join(tmpdir(), 'starsync-cli-cutover-'));
		try {
			for (const args of [[target], ['migrate', target]]) {
				const result = runCli(args);
				expect(result.exitCode).toBe(2);
				expect(result.stdout.toString()).toContain('starsync <command>');
				expect(result.stderr.toString()).toContain('explicit StarSync command is required');
				expect(existsSync(path.join(target, '.starsync'))).toBe(false);
			}
		} finally {
			rmSync(target, { force: true, recursive: true });
		}
	});

	test('keeps root and command help while rejecting command-specific flags elsewhere', () => {
		expect(runCli(['--help']).exitCode).toBe(0);
		for (const command of ['sync', 'verify', 'rename', 'dates', 'init', 'unlock']) {
			expect(runCli([command, '--help']).exitCode).toBe(0);
		}
		for (const args of [
			['sync', '--apply'],
			['verify', '--apply'],
			['rename', '--dry-run'],
			['dates', '--apply'],
			['init', '--apply'],
			['unlock', '--apply'],
		]) {
			expect(runCli(args).exitCode).toBe(2);
		}
	});
});

describe('public schema cutover', () => {
	test('exposes only the current archive operations', () => {
		expect(Object.keys(publicApi).sort()).toEqual([
			'DEFAULT_ARCHIVE_CONCURRENCY',
			'REPOSITORY_ID_KEY',
			'REPOSITORY_SLUG_KEY',
			'initArchive',
			'normalizeArchiveDates',
			'renameArchive',
			'syncArchive',
			'unlockArchive',
			'verifyArchive',
		]);
	});

	test('reports schema version 2 with rename data and no migration field', () => {
		const report = createCommandReport({
			checkouts: [
				{
					findings: [createFinding('info', 'rename-pending', 'Rename is pending.')],
					lifecycle: 'active',
					name: 'old-name',
					outcome: 'current',
					pendingRename: true,
					rename: {
						classification: 'pending',
						proposedName: 'repository--owner',
						repositoryId: 42,
						repositorySlug: 'owner/repository',
					},
				},
			],
			command: 'rename',
			exitCode: 0,
		});
		const serialized = JSON.stringify(report);
		expect(report.schemaVersion).toBe(2);
		expect(report.checkouts[0]?.rename?.classification).toBe('pending');
		expect(serialized).not.toContain('migration');
	});
});
