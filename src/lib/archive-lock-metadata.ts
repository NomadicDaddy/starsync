import { randomUUID } from 'node:crypto';
import os from 'node:os';

import type { Subcommand } from './cli-utils.ts';

import { isSubcommand } from './cli-utils.ts';

export interface ArchiveLockMetadata {
	command: Subcommand;
	hostname: string;
	lockId: string;
	pid: number;
	startedAt: string;
}

export type ArchiveProcessState = 'alive' | 'dead' | 'unknown';

export interface ArchiveLockRuntime {
	createLockId: () => string;
	getProcessState: (pid: number) => ArchiveProcessState;
	hostname: string;
	now: () => Date;
	pid: number;
}

const getErrorCode = (err: unknown): null | string => {
	if (typeof err !== 'object' || err === null || !('code' in err)) return null;
	return typeof err.code === 'string' ? err.code : null;
};

export const getProcessState = (pid: number): ArchiveProcessState => {
	try {
		process.kill(pid, 0);
		return 'alive';
	} catch (err) {
		return getErrorCode(err) === 'ESRCH' ? 'dead' : 'unknown';
	}
};

export const createArchiveLockRuntime = (): ArchiveLockRuntime => ({
	createLockId: randomUUID,
	getProcessState,
	hostname: os.hostname(),
	now: () => new Date(),
	pid: process.pid,
});

export const parseArchiveLockMetadata = (raw: string): ArchiveLockMetadata | null => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	if (
		typeof record.command !== 'string' ||
		!isSubcommand(record.command) ||
		typeof record.hostname !== 'string' ||
		!record.hostname.trim() ||
		typeof record.lockId !== 'string' ||
		!record.lockId.trim() ||
		typeof record.pid !== 'number' ||
		!Number.isInteger(record.pid) ||
		record.pid <= 0 ||
		typeof record.startedAt !== 'string' ||
		Number.isNaN(Date.parse(record.startedAt))
	) {
		return null;
	}
	return {
		command: record.command,
		hostname: record.hostname,
		lockId: record.lockId,
		pid: record.pid,
		startedAt: record.startedAt,
	};
};

export const describeArchiveLock = (metadata: ArchiveLockMetadata): string =>
	`${metadata.command} (PID ${metadata.pid} on ${metadata.hostname}, started ${metadata.startedAt})`;
