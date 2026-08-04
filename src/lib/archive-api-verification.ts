import type { VerifyArchiveOptions } from './archive-api-contract.ts';
import type { HeldArchiveLock } from './archive-lock.ts';
import type { ArchiveVerificationRepairOptions } from './archive-verification-repair.ts';
import type { ArchiveVerificationOptions } from './archive-verification.ts';
import type { CommandReport, Finding } from './reporting.ts';

import {
	getErrorMessage,
	interruptedReport,
	invalidTargetReport,
	missingTokenReport,
	operationFailureReport,
	resolveExplicitTarget,
} from './archive-api-reporting.ts';
import { getAuthenticatedArchiveOwner, readArchiveConfig } from './archive-config.ts';
import { getArchiveModificationFinding } from './archive-inspection.ts';
import { verifyArchive as verifyArchiveContents } from './archive-verification.ts';
import { checkFreeSpace, resolveMinFreeSpace } from './free-space.ts';
import { cleanupOwnedCheckoutArtifacts } from './owned-checkout-artifacts.ts';
import { createCommandReport } from './reporting.ts';
import { createGitHubRepositoryResolver } from './repository-resolution.ts';
import { sanitizeMessage } from './secret-safety.ts';

interface VerifyContext {
	force: boolean;
	minFreeSpace: number;
	targetPath: string;
	token: string;
}

const prepareVerifyContext = (options: VerifyArchiveOptions): CommandReport | VerifyContext => {
	const targetPath = resolveExplicitTarget(options.targetPath);
	if (targetPath === null) return invalidTargetReport('verify');
	if (options.signal?.aborted) return interruptedReport('verify', targetPath);
	const force = options.force === true;
	const token = options.token?.trim() ?? '';
	if (force && !token) {
		return missingTokenReport(
			'verify',
			targetPath,
			'GITHUB_TOKEN is required to resolve and re-clone damaged repositories.',
		);
	}
	const minFreeSpace = resolveMinFreeSpace(options.minFreeSpace);
	if (typeof minFreeSpace !== 'number') {
		return createCommandReport({
			command: 'verify',
			exitCode: 2,
			findings: [minFreeSpace],
			targetPath,
		});
	}
	return { force, minFreeSpace, targetPath, token };
};

/**
 * Gates forced repair on the free space its re-clones need, after the abandoned
 * owned artifacts have been cleared: that cleanup can be the reason the archive is
 * short, so measuring first would refuse a run that had already freed what it
 * needed. Read-only verification never reaches this, because it writes nothing.
 */
const checkRepairFreeSpace = (
	context: VerifyContext,
	cleanupFindings: Finding[],
): CommandReport | Finding[] => {
	const spaceFinding = checkFreeSpace(
		context.targetPath,
		context.minFreeSpace,
		'error',
		'replace damaged checkouts',
	);
	if (spaceFinding === null) return cleanupFindings;
	if (spaceFinding.severity !== 'error') return [...cleanupFindings, spaceFinding];
	return createCommandReport({
		command: 'verify',
		exitCode: 1,
		findings: [...cleanupFindings, spaceFinding],
		targetPath: context.targetPath,
	});
};

const prepareForcedRepair = async (
	targetPath: string,
	token: string,
): Promise<ArchiveVerificationRepairOptions | CommandReport> => {
	const modificationFinding = getArchiveModificationFinding(targetPath);
	if (modificationFinding !== null) {
		return createCommandReport({
			command: 'verify',
			exitCode: 1,
			findings: [modificationFinding],
			targetPath,
		});
	}
	const configuredOwner = readArchiveConfig(targetPath).owner;
	const authenticatedOwner = await getAuthenticatedArchiveOwner(token);
	if (authenticatedOwner.id !== configuredOwner.id) {
		return operationFailureReport(
			'verify',
			targetPath,
			'archive-owner-mismatch',
			`Archive belongs to GitHub account ${configuredOwner.login} (identity ${configuredOwner.id}), but the authenticated account is ${authenticatedOwner.login} (identity ${authenticatedOwner.id}).`,
		);
	}
	return {
		archiveOwnerId: configuredOwner.id,
		resolveRepository: createGitHubRepositoryResolver(token),
		targetPath,
	};
};

const reportVerification = async (
	context: VerifyContext,
	verificationOptions: ArchiveVerificationOptions,
	carriedFindings: Finding[],
): Promise<CommandReport> => {
	const result = await verifyArchiveContents(context.targetPath, verificationOptions);
	return createCommandReport({
		checkouts: result.checkouts,
		command: 'verify',
		exitCode: result.exitCode,
		findings: [...result.findings, ...carriedFindings],
		interrupted: result.interrupted,
		targetPath: context.targetPath,
	});
};

const runVerification = async (
	options: VerifyArchiveOptions,
	context: VerifyContext,
	held: HeldArchiveLock | null,
): Promise<CommandReport> => {
	const repair = context.force
		? await prepareForcedRepair(context.targetPath, context.token)
		: undefined;
	if (repair !== undefined && 'command' in repair) return repair;
	const verificationOptions: ArchiveVerificationOptions = {
		isInterruptionRequested: () => options.signal?.aborted ?? false,
	};
	if (options.onProgress !== undefined) verificationOptions.onProgress = options.onProgress;
	if (repair === undefined) return await reportVerification(context, verificationOptions, []);
	verificationOptions.repair = repair;
	const prepared = checkRepairFreeSpace(
		context,
		cleanupOwnedCheckoutArtifacts(context.targetPath, held, options.onProgress),
	);
	if ('schemaVersion' in prepared) return prepared;
	return await reportVerification(context, verificationOptions, prepared);
};

export const verifyArchiveUnlocked = async (
	options: VerifyArchiveOptions,
	held: HeldArchiveLock | null,
): Promise<CommandReport> => {
	const context = prepareVerifyContext(options);
	if ('command' in context) return context;
	options.onProgress?.(`Archive: ${context.targetPath}`);
	options.onProgress?.(
		context.force
			? 'Forced recovery is enabled; damaged or locally modified checkouts will be replaced with validated fresh clones.'
			: 'Verification is read-only; no archive data will be changed.',
	);
	try {
		return await runVerification(options, context, held);
	} catch (err) {
		return operationFailureReport(
			'verify',
			context.targetPath,
			'archive-verification-failed',
			`Archive verification failed: ${sanitizeMessage(getErrorMessage(err))}`,
		);
	}
};
