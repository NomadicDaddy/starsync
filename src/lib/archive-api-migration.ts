import type { MigrateArchiveOptions } from './archive-api.ts';
import type { CommandReport } from './reporting.ts';

import {
	getErrorMessage,
	interruptedReport,
	invalidTargetReport,
	missingTokenReport,
	operationFailureReport,
	resolveExplicitTarget,
} from './archive-api-reporting.ts';
import { getAuthenticatedArchiveOwner } from './archive-config.ts';
import { applyArchiveMigration } from './archive-migration-apply.ts';
import { createGitHubRepositoryResolver, previewArchiveMigration } from './archive-migration.ts';
import { createCommandReport } from './reporting.ts';
import { sanitizeMessage } from './secret-safety.ts';

export const migrateArchiveUnlocked = async (
	options: MigrateArchiveOptions
): Promise<CommandReport> => {
	const targetPath = resolveExplicitTarget(options.targetPath);
	if (targetPath === null) return invalidTargetReport('migrate');
	const apply = options.apply === true;
	if (options.signal?.aborted) return interruptedReport('migrate', targetPath, !apply);
	if (!options.token.trim()) {
		return missingTokenReport(
			'migrate',
			targetPath,
			'GITHUB_TOKEN is required to resolve repository identities.',
			!apply
		);
	}
	options.onProgress?.(`Archive: ${targetPath}`);
	options.onProgress?.(
		apply
			? 'Applying managed checkout identity migration.'
			: 'Migration preview is read-only; no archive data will be changed.'
	);
	try {
		const migrationOptions = {
			isInterruptionRequested: () => options.signal?.aborted ?? false,
			...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
		};
		const resolver = createGitHubRepositoryResolver(options.token);
		const result = apply
			? await applyArchiveMigration(
					targetPath,
					resolver,
					await getAuthenticatedArchiveOwner(options.token),
					migrationOptions
				)
			: await previewArchiveMigration(targetPath, resolver, migrationOptions);
		return createCommandReport({
			checkouts: result.checkouts,
			command: 'migrate',
			dryRun: !apply,
			exitCode: result.exitCode,
			findings: result.findings,
			interrupted: result.interrupted,
			targetPath,
		});
	} catch (err) {
		return operationFailureReport(
			'migrate',
			targetPath,
			apply ? 'migration-apply-failed' : 'migration-preview-failed',
			`Migration ${apply ? 'application' : 'preview'} failed: ${sanitizeMessage(getErrorMessage(err))}`,
			!apply
		);
	}
};
