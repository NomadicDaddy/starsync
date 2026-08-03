import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	initArchive,
	normalizeArchiveDates,
	renameArchive,
	syncArchive,
	verifyArchive,
} from '../src/index.ts';
import {
	acquireArchiveLock,
	type ArchiveLockRuntime,
	readArchiveLock,
	releaseArchiveLock,
} from '../src/lib/archive-lock.ts';
import { unlockArchiveWithRuntime } from '../src/lib/archive-unlock.ts';

const targets: string[] = [];
const projectRoot = path.resolve(import.meta.dir, '..');
const archiveLockPath = (target: string): string =>
	path.join(target, '.starsync', 'operation-lock.json');

const createTarget = (name: string): string => {
	const target = mkdtempSync(path.join(os.tmpdir(), `starsync-${name}-`));
	targets.push(target);
	return target;
};

const createRuntime = (
	hostname: string,
	pid: number,
	processState: ArchiveLockRuntime['getProcessState'],
): ArchiveLockRuntime => ({
	createLockId: () => `${hostname}-${pid}`,
	getProcessState: processState,
	hostname,
	now: () => new Date('2026-07-23T12:00:00.000Z'),
	pid,
});

afterEach(() => {
	for (const target of targets.splice(0)) {
		rmSync(target, { force: true, recursive: true });
	}
});

describe('archive operation locking', () => {
	test('records portable ownership metadata and identifies a live owner', () => {
		const target = createTarget('lock-live');
		const ownerRuntime = createRuntime('portable-host', 101, () => 'alive');
		const acquisition = acquireArchiveLock(target, 'sync', ownerRuntime);
		expect(acquisition.ok).toBe(true);
		if (!acquisition.ok) throw new Error(acquisition.message);

		expect(readArchiveLock(target)?.metadata).toEqual({
			command: 'sync',
			hostname: 'portable-host',
			lockId: 'portable-host-101',
			pid: 101,
			startedAt: '2026-07-23T12:00:00.000Z',
		});

		const contender = acquireArchiveLock(
			target,
			'verify',
			createRuntime('PORTABLE-HOST', 202, () => 'alive'),
		);
		expect(contender.ok).toBe(false);
		if (contender.ok) throw new Error('Expected the live lock to block acquisition.');
		expect(contender.code).toBe('archive-lock-active');
		expect(contender.message).toContain('sync (PID 101 on portable-host');

		expect(releaseArchiveLock(acquisition.held)).toEqual({ ok: true, removed: true });
		expect(existsSync(archiveLockPath(target))).toBe(false);
		expect(readdirSync(target)).toEqual([]);
	});

	for (const platform of ['win32', 'darwin', 'linux'] as const) {
		test(`reclaims a confirmed-dead same-host lock on ${platform}`, () => {
			const target = createTarget(`lock-stale-${platform}`);
			const hostname = `${platform}-host`;
			const stale = acquireArchiveLock(
				target,
				'dates',
				createRuntime(hostname, 303, () => 'alive'),
			);
			expect(stale.ok).toBe(true);
			if (!stale.ok) throw new Error(stale.message);

			const liveContender = acquireArchiveLock(
				target,
				'verify',
				createRuntime(hostname, 404, () => 'alive'),
			);
			expect(liveContender.ok).toBe(false);
			if (liveContender.ok) throw new Error('Expected the live lock to block acquisition.');
			expect(liveContender.code).toBe('archive-lock-active');

			const replacement = acquireArchiveLock(
				target,
				'verify',
				createRuntime(hostname, 404, () => 'dead'),
			);
			expect(replacement.ok).toBe(true);
			if (!replacement.ok) throw new Error(replacement.message);
			expect(replacement.reclaimed?.pid).toBe(303);
			expect(replacement.held.metadata.command).toBe('verify');

			expect(releaseArchiveLock(replacement.held)).toEqual({ ok: true, removed: true });
			expect(readdirSync(target)).toEqual([]);
		});
	}

	for (const platform of ['win32', 'darwin', 'linux'] as const) {
		test(`requires force for a remote lock and reports risk on ${platform}`, () => {
			const target = createTarget(`lock-remote-${platform}`);
			const remote = acquireArchiveLock(
				target,
				'rename',
				createRuntime('remote-host', 505, () => 'alive'),
			);
			expect(remote.ok).toBe(true);
			if (!remote.ok) throw new Error(remote.message);
			const localRuntime = createRuntime(`${platform}-host`, 606, () => 'unknown');

			const refused = unlockArchiveWithRuntime({ targetPath: target }, localRuntime);
			expect(refused.exitCode).toBe(1);
			expect(refused.findings[0]?.code).toBe('archive-lock-force-required');
			expect(existsSync(archiveLockPath(target))).toBe(true);

			const progress: string[] = [];
			const forced = unlockArchiveWithRuntime(
				{
					force: true,
					onProgress: (message) => progress.push(message),
					targetPath: target,
				},
				localRuntime,
			);
			expect(progress[0]).toContain('WARNING: Lock owner is remote');
			expect(forced.exitCode).toBe(0);
			expect(forced.findings[0]?.code).toBe('archive-lock-force-removed');
			expect(forced.findings[0]?.severity).toBe('warning');
			expect(existsSync(archiveLockPath(target))).toBe(false);
		});
	}

	test('never force-removes a confirmed live same-host lock', () => {
		const target = createTarget('lock-force-live');
		const runtime = createRuntime('same-host', 707, () => 'alive');
		const acquisition = acquireArchiveLock(target, 'init', runtime);
		expect(acquisition.ok).toBe(true);
		if (!acquisition.ok) throw new Error(acquisition.message);

		const report = unlockArchiveWithRuntime({ force: true, targetPath: target }, runtime);
		expect(report.exitCode).toBe(1);
		expect(report.findings[0]?.code).toBe('archive-lock-active');
		expect(existsSync(archiveLockPath(target))).toBe(true);
		expect(releaseArchiveLock(acquisition.held)).toEqual({ ok: true, removed: true });
	});

	test('requires force when same-host process liveness is uncertain', () => {
		const target = createTarget('lock-uncertain');
		const ownerRuntime = createRuntime('same-host', 808, () => 'alive');
		const acquisition = acquireArchiveLock(target, 'sync', ownerRuntime);
		expect(acquisition.ok).toBe(true);
		if (!acquisition.ok) throw new Error(acquisition.message);
		const uncertainRuntime = createRuntime('same-host', 909, () => 'unknown');

		const contender = acquireArchiveLock(target, 'dates', uncertainRuntime);
		expect(contender.ok).toBe(false);
		if (contender.ok) throw new Error('Expected uncertain ownership to block acquisition.');
		expect(contender.code).toBe('archive-lock-force-required');
		expect(unlockArchiveWithRuntime({ targetPath: target }, uncertainRuntime).exitCode).toBe(1);
		expect(
			unlockArchiveWithRuntime({ force: true, targetPath: target }, uncertainRuntime)
				.exitCode,
		).toBe(0);
	});

	test('routes --force through the unlock CLI', async () => {
		const target = createTarget('lock-cli-force');
		mkdirSync(path.join(target, '.starsync'));
		writeFileSync(archiveLockPath(target), 'invalid lock metadata', 'utf8');
		const { dispatchUnlock } = await import('../src/lib/subcommands.ts');

		expect(dispatchUnlock(['--force', target])).toBe(0);
		expect(existsSync(archiveLockPath(target))).toBe(false);
	});

	test('locks the dates CLI entrypoint through the unified dispatcher', () => {
		const target = createTarget('lock-dates-cli');
		const acquisition = acquireArchiveLock(
			target,
			'verify',
			createRuntime(os.hostname(), process.pid, () => 'alive'),
		);
		expect(acquisition.ok).toBe(true);
		if (!acquisition.ok) throw new Error(acquisition.message);
		const originalLock = readArchiveLock(target)?.raw;

		const result = Bun.spawnSync({
			cmd: [process.execPath, 'src/cli.ts', 'dates', '--dry-run', target],
			cwd: projectRoot,
			stderr: 'pipe',
			stdout: 'pipe',
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain('archive-lock-active');
		expect(readArchiveLock(target)?.raw).toBe(originalLock);
		expect(releaseArchiveLock(acquisition.held)).toEqual({ ok: true, removed: true });
	});

	test('blocks every public archive operation before it inspects or modifies the archive', async () => {
		const target = createTarget('lock-all-operations');
		const runtime = createRuntime(os.hostname(), process.pid, () => 'alive');
		const acquisition = acquireArchiveLock(target, 'verify', runtime);
		expect(acquisition.ok).toBe(true);
		if (!acquisition.ok) throw new Error(acquisition.message);
		const originalLock = readArchiveLock(target)?.raw;

		const reports = await Promise.all([
			initArchive({ targetPath: target, token: '' }),
			renameArchive({ targetPath: target, token: '' }),
			syncArchive({ targetPath: target, token: '' }),
			syncArchive({ dryRun: true, targetPath: target, token: '' }),
			verifyArchive({ targetPath: target }),
			normalizeArchiveDates({ targetPath: target }),
		]);
		for (const report of reports) {
			expect(report.exitCode).toBe(1);
			expect(report.findings[0]?.code).toBe('archive-lock-active');
		}
		expect(readArchiveLock(target)?.raw).toBe(originalLock);
		expect(readdirSync(target)).toEqual(['.starsync']);
		expect(releaseArchiveLock(acquisition.held)).toEqual({ ok: true, removed: true });
	});
});
