import type { RenameArchiveOptions } from './archive-api.ts';
import type { RenameOptions } from './archive-rename.ts';
import type { CommandReport } from './reporting.ts';

import {
	getErrorMessage,
	interruptedReport,
	invalidTargetReport,
	missingTokenReport,
	operationFailureReport,
	resolveExplicitTarget,
} from './archive-api-reporting.ts';
import { readArchiveConfig, getAuthenticatedArchiveOwner } from './archive-config.ts';
import { getArchiveModificationFinding } from './archive-inspection.ts';
import { applyArchiveRenames } from './archive-rename-apply.ts';
import { previewArchiveRenames } from './archive-rename.ts';
import { createCommandReport } from './reporting.ts';
import { createGitHubRepositoryResolver } from './repository-resolution.ts';
import { sanitizeMessage } from './secret-safety.ts';

interface RenameContext {
	apply: boolean;
	targetPath: string;
}

const prepareContext = (options: RenameArchiveOptions): CommandReport | RenameContext => {
	const targetPath = resolveExplicitTarget(options.targetPath);
	if (targetPath === null) return invalidTargetReport('rename');
	const apply = options.apply === true;
	if (options.signal?.aborted) return interruptedReport('rename', targetPath, !apply);
	if (!options.token.trim()) {
		return missingTokenReport(
			'rename',
			targetPath,
			'GITHUB_TOKEN is required to resolve repositories.',
			!apply
		);
	}
	return { apply, targetPath };
};

const verifyApplyOwner = async (
	targetPath: string,
	token: string
): Promise<CommandReport | null> => {
	const configured = readArchiveConfig(targetPath).owner;
	const authenticated = await getAuthenticatedArchiveOwner(token);
	return authenticated.id === configured.id
		? null
		: operationFailureReport(
				'rename',
				targetPath,
				'archive-owner-mismatch',
				`Archive belongs to GitHub account ${configured.login} (identity ${configured.id}), but the authenticated account is ${authenticated.login} (identity ${authenticated.id}).`
			);
};

const validateApplication = async (
	context: RenameContext,
	token: string
): Promise<CommandReport | null> => {
	if (!context.apply) return null;
	const finding = getArchiveModificationFinding(context.targetPath);
	if (finding !== null) {
		return createCommandReport({
			command: 'rename',
			exitCode: 1,
			findings: [finding],
			targetPath: context.targetPath,
		});
	}
	return verifyApplyOwner(context.targetPath, token);
};

const executeRename = async (
	options: RenameArchiveOptions,
	context: RenameContext
): Promise<CommandReport> => {
	const renameOptions: RenameOptions = {
		isInterruptionRequested: () => options.signal?.aborted ?? false,
		...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
	};
	const resolver = createGitHubRepositoryResolver(options.token);
	const result = context.apply
		? await applyArchiveRenames(context.targetPath, resolver, renameOptions)
		: await previewArchiveRenames(context.targetPath, resolver, renameOptions);
	return createCommandReport({
		checkouts: result.checkouts,
		command: 'rename',
		dryRun: !context.apply,
		exitCode: result.exitCode,
		findings: result.findings,
		interrupted: result.interrupted,
		targetPath: context.targetPath,
	});
};

const failureReport = (context: RenameContext, err: unknown): CommandReport =>
	operationFailureReport(
		'rename',
		context.targetPath,
		context.apply ? 'rename-apply-failed' : 'rename-preview-failed',
		`Rename ${context.apply ? 'application' : 'preview'} failed: ${sanitizeMessage(getErrorMessage(err))}`,
		!context.apply
	);

export const renameArchiveUnlocked = async (
	options: RenameArchiveOptions
): Promise<CommandReport> => {
	const context = prepareContext(options);
	if ('command' in context) return context;
	options.onProgress?.(`Archive: ${context.targetPath}`);
	options.onProgress?.(
		context.apply
			? 'Applying canonical checkout renames.'
			: 'Rename preview is read-only; no archive data will be changed.'
	);
	try {
		const validation = await validateApplication(context, options.token);
		return validation ?? (await executeRename(options, context));
	} catch (err) {
		return failureReport(context, err);
	}
};
