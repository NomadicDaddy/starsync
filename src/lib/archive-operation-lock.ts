import fs from 'node:fs';
import path from 'node:path';

import type { ArchiveLockMetadata, HeldArchiveLock } from './archive-lock.ts';
import type { Subcommand } from './cli-utils.ts';
import type { CommandReport, Finding } from './reporting.ts';

import { acquireArchiveLock, describeArchiveLock, releaseArchiveLock } from './archive-lock.ts';
import { createCommandReport, createFinding } from './reporting.ts';

interface LockableOperationOptions {
	onProgress?: (message: string) => void;
	targetPath: string;
}

const resolveLockableTarget = (targetPath: string): null | string => {
	const trimmed = targetPath.trim();
	if (!trimmed) return null;
	const resolved = path.resolve(trimmed);
	try {
		return fs.statSync(resolved).isDirectory() ? resolved : null;
	} catch {
		return null;
	}
};

const rebuildReport = (
	report: CommandReport,
	additionalFindings: Finding[],
	releaseFailed = false,
): CommandReport => {
	if (additionalFindings.length === 0) return report;
	return createCommandReport({
		checkouts: report.checkouts,
		command: report.command,
		dryRun: report.dryRun,
		exitCode: releaseFailed && report.exitCode !== 130 ? 1 : report.exitCode,
		findings: [...report.findings, ...additionalFindings],
		...(report.helpText === undefined ? {} : { helpText: report.helpText }),
		interrupted: report.interrupted,
		targetPath: report.targetPath,
	});
};

const lockFailureReport = (
	command: Exclude<Subcommand, 'unlock'>,
	targetPath: string,
	code: string,
	message: string,
	dryRun: boolean,
): CommandReport =>
	createCommandReport({
		command,
		dryRun,
		exitCode: 1,
		findings: [createFinding('error', code, message)],
		targetPath,
	});

const finishLockedOperation = (
	report: CommandReport,
	held: HeldArchiveLock,
	reclaimedFinding: Finding | null,
): CommandReport => {
	const removal = releaseArchiveLock(held);
	const findings = reclaimedFinding === null ? [] : [reclaimedFinding];
	if (removal.ok) return rebuildReport(report, findings);
	return rebuildReport(
		report,
		[...findings, createFinding('error', removal.code, removal.message)],
		true,
	);
};

const getReclaimedFinding = (
	reclaimed: ArchiveLockMetadata | null,
	onProgress?: (message: string) => void,
): Finding | null => {
	if (reclaimed === null) return null;
	const message = `Reclaimed stale archive lock from ${describeArchiveLock(reclaimed)}.`;
	onProgress?.(message);
	return createFinding('info', 'stale-archive-lock-reclaimed', message);
};

export const withArchiveOperationLock = async (
	command: Exclude<Subcommand, 'unlock'>,
	options: LockableOperationOptions,
	operation: (held: HeldArchiveLock | null) => CommandReport | Promise<CommandReport>,
	dryRun = false,
): Promise<CommandReport> => {
	const targetPath = resolveLockableTarget(options.targetPath);
	if (targetPath === null) return operation(null);
	const acquisition = acquireArchiveLock(targetPath, command);
	if (!acquisition.ok) {
		return lockFailureReport(
			command,
			targetPath,
			acquisition.code,
			acquisition.message,
			dryRun,
		);
	}
	const reclaimedFinding = getReclaimedFinding(acquisition.reclaimed, options.onProgress);
	let report: CommandReport;
	try {
		report = await operation(acquisition.held);
	} catch (err) {
		releaseArchiveLock(acquisition.held);
		throw err;
	}
	return finishLockedOperation(report, acquisition.held, reclaimedFinding);
};
