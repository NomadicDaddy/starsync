import type { NormalizeArchiveDatesOptions } from './archive-api.ts';
import type { CommandReport } from './reporting.ts';

import {
	interruptedReport,
	invalidTargetReport,
	resolveExplicitTarget,
} from './archive-api-reporting.ts';
import { getArchiveModificationFinding } from './archive-inspection.ts';
import { formatDatesTables, runDatesCommand } from './dates-command.ts';
import { createCommandReport } from './reporting.ts';

export const normalizeArchiveDatesUnlocked = async (
	options: NormalizeArchiveDatesOptions
): Promise<CommandReport> => {
	const targetPath = resolveExplicitTarget(options.targetPath);
	if (targetPath === null) return invalidTargetReport('dates');
	const dryRun = options.dryRun ?? false;
	if (options.signal?.aborted) return interruptedReport('dates', targetPath, dryRun);
	const restriction = getArchiveModificationFinding(targetPath);
	if (restriction) {
		return createCommandReport({
			command: 'dates',
			dryRun,
			exitCode: 1,
			findings: [restriction],
			targetPath,
		});
	}
	options.onProgress?.(`Root: ${targetPath}`);
	const result = await runDatesCommand(targetPath, {
		dryRun,
		...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
	for (const line of formatDatesTables(result.displayRows)) options.onProgress?.(line);
	return createCommandReport({
		checkouts: result.checkouts,
		command: 'dates',
		dryRun,
		exitCode: result.exitCode,
		findings: result.findings,
		interrupted: result.interrupted,
		targetPath,
	});
};
