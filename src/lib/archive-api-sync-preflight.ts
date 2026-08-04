import fs from 'node:fs';

import type {
	ArchiveProgressCallback,
	SyncArchiveOptions,
	SyncContext,
} from './archive-api-contract.ts';
import type { HeldArchiveLock } from './archive-lock.ts';
import type { CommandReport, Finding } from './reporting.ts';

import { DEFAULT_ARCHIVE_CONCURRENCY } from './archive-api-contract.ts';
import {
	getErrorMessage,
	interruptedReport,
	invalidTargetReport,
	missingTokenReport,
	operationFailureReport,
	resolveExplicitTarget,
} from './archive-api-reporting.ts';
import { checkFreeSpace, resolveMinFreeSpace } from './free-space.ts';
import { cleanupOwnedCheckoutArtifacts } from './owned-checkout-artifacts.ts';
import { createCommandReport, createFinding } from './reporting.ts';

const MAX_ARCHIVE_CONCURRENCY = 8;
const MIN_ARCHIVE_CONCURRENCY = 1;

type SyncTuning = Pick<SyncContext, 'concurrency' | 'minFreeSpace'>;

const validateSyncTuning = (options: SyncArchiveOptions): Finding | SyncTuning => {
	const concurrency = options.concurrency ?? DEFAULT_ARCHIVE_CONCURRENCY;
	if (
		!Number.isInteger(concurrency) ||
		concurrency < MIN_ARCHIVE_CONCURRENCY ||
		concurrency > MAX_ARCHIVE_CONCURRENCY
	) {
		return createFinding(
			'error',
			'invalid-concurrency',
			`concurrency must be an integer from ${MIN_ARCHIVE_CONCURRENCY} to ${MAX_ARCHIVE_CONCURRENCY}.`,
		);
	}
	const minFreeSpace = resolveMinFreeSpace(options.minFreeSpace);
	if (typeof minFreeSpace !== 'number') return minFreeSpace;
	return { concurrency, minFreeSpace };
};

export const validateSyncOptions = (options: SyncArchiveOptions): CommandReport | SyncContext => {
	const targetPath = resolveExplicitTarget(options.targetPath);
	if (targetPath === null) return invalidTargetReport('sync');
	const dryRun = options.dryRun ?? false;
	if (options.signal?.aborted) return interruptedReport('sync', targetPath, dryRun);
	if (!options.token.trim()) {
		return missingTokenReport('sync', targetPath, 'GITHUB_TOKEN is not set.', dryRun);
	}
	const tuning = validateSyncTuning(options);
	if ('severity' in tuning) {
		return createCommandReport({
			command: 'sync',
			dryRun,
			exitCode: 2,
			findings: [tuning],
			targetPath,
		});
	}
	return { ...tuning, dryRun, targetPath };
};

/**
 * A dry run reports a shortfall without failing, because a preview writes nothing
 * and the operator still needs to see what a real run would hit.
 */
const checkSyncFreeSpace = (context: SyncContext): Finding | null =>
	checkFreeSpace(
		context.targetPath,
		context.minFreeSpace,
		context.dryRun ? 'warning' : 'error',
		'synchronize',
	);

/**
 * Readies the target for synchronization and reports what the caller must carry
 * into its final report. A returned report is a refusal that stops the run
 * before any repository work begins.
 *
 * Abandoned owned artifacts are removed before the filesystem is measured. That
 * cleanup is owed to every mutating sync, and a staging directory left by an
 * interrupted run can be the reason the archive is short on space, so measuring
 * first would refuse a run that had already freed what it needed.
 */
export const prepareSyncTarget = (
	context: SyncContext,
	held: HeldArchiveLock | null,
	onProgress?: ArchiveProgressCallback,
): CommandReport | Finding[] => {
	try {
		if (!context.dryRun) fs.mkdirSync(context.targetPath, { recursive: true });
	} catch (err) {
		return operationFailureReport(
			'sync',
			context.targetPath,
			'target-create-failed',
			`Cannot create target directory: ${getErrorMessage(err)}`,
			context.dryRun,
		);
	}
	const cleanupFindings = context.dryRun
		? []
		: cleanupOwnedCheckoutArtifacts(context.targetPath, held, onProgress);
	const spaceFinding = checkSyncFreeSpace(context);
	if (spaceFinding === null) return cleanupFindings;
	if (spaceFinding.severity !== 'error') return [...cleanupFindings, spaceFinding];
	return createCommandReport({
		command: 'sync',
		dryRun: context.dryRun,
		exitCode: 1,
		findings: [...cleanupFindings, spaceFinding],
		targetPath: context.targetPath,
	});
};
