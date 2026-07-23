import fs from 'node:fs';
import path from 'node:path';

import type { ArchiveLockRuntime } from './archive-lock.ts';
import type { CommandReport, Finding } from './reporting.ts';

import {
	createArchiveLockRuntime,
	describeArchiveLock,
	readArchiveLock,
	removeArchiveLock,
} from './archive-lock.ts';
import { createCommandReport, createFinding } from './reporting.ts';

export interface UnlockArchiveOptions {
	force?: boolean;
	onProgress?: (message: string) => void;
	targetPath: string;
}

const unlockReport = (
	targetPath: null | string,
	exitCode: CommandReport['exitCode'],
	finding: Finding
): CommandReport =>
	createCommandReport({
		command: 'unlock',
		exitCode,
		findings: [finding],
		targetPath,
	});

const forceRequiredReport = (targetPath: string, message: string): CommandReport =>
	unlockReport(
		targetPath,
		1,
		createFinding(
			'error',
			'archive-lock-force-required',
			`${message} Use unlock --force only after confirming no operation still uses the archive.`
		)
	);

export const unlockArchiveWithRuntime = (
	options: UnlockArchiveOptions,
	runtime: ArchiveLockRuntime
): CommandReport => {
	const trimmedTarget = options.targetPath.trim();
	if (!trimmedTarget) {
		return unlockReport(
			null,
			2,
			createFinding('error', 'invalid-target', 'targetPath must be a non-empty string.')
		);
	}
	const targetPath = path.resolve(trimmedTarget);
	try {
		if (!fs.statSync(targetPath).isDirectory()) throw new Error('Path is not a directory.');
	} catch {
		return unlockReport(
			targetPath,
			1,
			createFinding('error', 'target-not-found', `Archive path does not exist: ${targetPath}`)
		);
	}

	let snapshot;
	try {
		snapshot = readArchiveLock(targetPath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return unlockReport(
			targetPath,
			1,
			createFinding(
				'error',
				'archive-lock-read-failed',
				`Cannot read archive lock: ${message}`
			)
		);
	}
	if (snapshot === null) {
		return unlockReport(
			targetPath,
			0,
			createFinding('info', 'archive-not-locked', 'Archive has no operation lock.')
		);
	}

	let forcedMessage: string;
	if (snapshot.metadata === null) {
		if (!options.force) {
			return forceRequiredReport(
				targetPath,
				'Archive lock metadata is invalid or incomplete.'
			);
		}
		forcedMessage = 'Archive lock ownership is unknown because its metadata is invalid.';
	} else {
		const owner = snapshot.metadata;
		const sameHost =
			owner.hostname.trim().toLowerCase() === runtime.hostname.trim().toLowerCase();
		if (sameHost) {
			const processState = runtime.getProcessState(owner.pid);
			if (processState === 'alive') {
				return unlockReport(
					targetPath,
					1,
					createFinding(
						'error',
						'archive-lock-active',
						`Refusing to unlock live operation ${describeArchiveLock(owner)}.`
					)
				);
			}
			if (processState === 'dead') {
				const removal = removeArchiveLock(targetPath, snapshot.raw, true);
				if (!removal.ok) {
					return unlockReport(
						targetPath,
						1,
						createFinding('error', removal.code, removal.message)
					);
				}
				return unlockReport(
					targetPath,
					0,
					createFinding(
						'info',
						'stale-archive-lock-removed',
						`Removed stale lock from ${describeArchiveLock(owner)}.`
					)
				);
			}
			if (!options.force) {
				return forceRequiredReport(
					targetPath,
					`Process liveness is uncertain for ${describeArchiveLock(owner)}.`
				);
			}
			forcedMessage = `Process liveness is uncertain for ${describeArchiveLock(owner)}.`;
		} else {
			if (!options.force) {
				return forceRequiredReport(
					targetPath,
					`Lock owner is remote: ${describeArchiveLock(owner)}.`
				);
			}
			forcedMessage = `Lock owner is remote: ${describeArchiveLock(owner)}.`;
		}
	}

	const riskMessage = `${forcedMessage} Forced removal can allow concurrent archive changes.`;
	options.onProgress?.(`WARNING: ${riskMessage}`);
	const removal = removeArchiveLock(targetPath, snapshot.raw, true);
	if (!removal.ok) {
		return unlockReport(targetPath, 1, createFinding('error', removal.code, removal.message));
	}
	return unlockReport(
		targetPath,
		0,
		createFinding('warning', 'archive-lock-force-removed', riskMessage)
	);
};

export const unlockArchive = (options: UnlockArchiveOptions): CommandReport =>
	unlockArchiveWithRuntime(options, createArchiveLockRuntime());
