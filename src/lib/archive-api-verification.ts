import type { VerifyArchiveOptions } from './archive-api.ts';
import type { CommandReport } from './reporting.ts';

import {
	getErrorMessage,
	interruptedReport,
	invalidTargetReport,
	operationFailureReport,
	resolveExplicitTarget,
} from './archive-api-reporting.ts';
import { verifyArchive as verifyArchiveContents } from './archive-verification.ts';
import { createCommandReport } from './reporting.ts';
import { sanitizeMessage } from './secret-safety.ts';

export const verifyArchiveUnlocked = async (
	options: VerifyArchiveOptions
): Promise<CommandReport> => {
	const targetPath = resolveExplicitTarget(options.targetPath);
	if (targetPath === null) return invalidTargetReport('verify');
	if (options.signal?.aborted) return interruptedReport('verify', targetPath);
	options.onProgress?.(`Archive: ${targetPath}`);
	options.onProgress?.('Verification is read-only; no archive data will be changed.');
	try {
		const result = await verifyArchiveContents(targetPath, {
			isInterruptionRequested: () => options.signal?.aborted ?? false,
			...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
		});
		return createCommandReport({
			checkouts: result.checkouts,
			command: 'verify',
			exitCode: result.exitCode,
			findings: result.findings,
			interrupted: result.interrupted,
			targetPath,
		});
	} catch (err) {
		return operationFailureReport(
			'verify',
			targetPath,
			'archive-verification-failed',
			`Archive verification failed: ${sanitizeMessage(getErrorMessage(err))}`
		);
	}
};
