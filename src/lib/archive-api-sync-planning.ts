import path from 'node:path';

import type { SyncArchiveOptions, SyncContext } from './archive-api-contract.ts';
import type { ManagedSyncPlan, StarredRepository } from './managed-checkout-planning.ts';
import type { CheckoutReport, CommandReport } from './reporting.ts';

import {
	checkoutExists,
	createInterruptedCheckout,
	getErrorMessage,
} from './archive-api-reporting.ts';
import { inspectArchiveDate } from './archive-dates.ts';
import { createCommandReport, createFinding } from './reporting.ts';
import { isGitHubDotComUrl, sanitizeMessage, sanitizeUrl } from './secret-safety.ts';

const plannedDateFinding = async (
	targetPath: string,
	repository: StarredRepository,
	isCloned: boolean
) => {
	if (!isCloned) {
		return createFinding(
			'info',
			'date-update-planned',
			'After cloning, the folder timestamp would be set to its Archive Date.'
		);
	}
	try {
		const state = await inspectArchiveDate(path.join(targetPath, repository.folderName));
		return state.needsUpdate
			? createFinding(
					'info',
					'date-update-planned',
					`Folder timestamp would be set to Archive Date ${state.archiveDate.toISOString()}.`
				)
			: null;
	} catch (err) {
		return createFinding(
			'error',
			'archive-date-read-failed',
			`Cannot calculate the planned Archive Date: ${sanitizeMessage(getErrorMessage(err))}`
		);
	}
};

const createPlannedReport = async (
	targetPath: string,
	repository: StarredRepository
): Promise<CheckoutReport> => {
	const isCloned = checkoutExists(targetPath, repository.folderName);
	const dateFinding = await plannedDateFinding(targetPath, repository, isCloned);
	return {
		findings: [
			createFinding(
				'info',
				isCloned ? 'refresh-planned' : 'clone-planned',
				isCloned ? 'Checkout would be refreshed.' : 'Repository would be added.'
			),
			...(dateFinding === null ? [] : [dateFinding]),
		],
		lifecycle: isCloned ? 'active' : null,
		name: repository.folderName,
		outcome: 'skipped',
		pendingRename: repository.pendingRename,
		plannedOutcome: isCloned ? 'updated' : 'added',
	};
};

const createUninspectedReports = (
	targetPath: string,
	repositories: StarredRepository[]
): CheckoutReport[] =>
	repositories.map((repository) =>
		createInterruptedCheckout(
			repository.folderName,
			checkoutExists(targetPath, repository.folderName) ? 'active' : null,
			'interrupted-before-inspection',
			'Repository was not inspected because interruption was requested.',
			repository.pendingRename
		)
	);

export const partitionValidRepositories = (
	targetPath: string,
	repositories: StarredRepository[]
): { invalid: CheckoutReport[]; valid: StarredRepository[] } => {
	const invalid: CheckoutReport[] = [];
	const valid: StarredRepository[] = [];
	for (const repository of repositories) {
		if (isGitHubDotComUrl(repository.clone_url)) {
			valid.push(repository);
			continue;
		}
		invalid.push({
			findings: [
				createFinding(
					'error',
					'invalid-origin',
					`Repository origin is not GitHub.com: ${sanitizeUrl(repository.clone_url)}`
				),
			],
			lifecycle: checkoutExists(targetPath, repository.folderName) ? 'active' : null,
			name: repository.folderName,
			outcome: 'failed',
			pendingRename: repository.pendingRename,
		});
	}
	return { invalid, valid };
};

export const previewSync = async (
	plan: ManagedSyncPlan,
	context: SyncContext,
	options: SyncArchiveOptions
): Promise<CommandReport> => {
	options.onProgress?.('Dry run: querying stars and inspecting the archive without changes.');
	const planned: CheckoutReport[] = [];
	for (const [index, repository] of plan.repositories.entries()) {
		if (options.signal?.aborted) {
			planned.push(
				...createUninspectedReports(context.targetPath, plan.repositories.slice(index))
			);
			break;
		}
		const isCloned = checkoutExists(context.targetPath, repository.folderName);
		options.onProgress?.(
			`Syncing ${index + 1}/${plan.repositories.length} — ${repository.folderName} — would ${isCloned ? 'refresh' : 'clone'}`
		);
		if (options.signal?.aborted) {
			planned.push(
				...createUninspectedReports(context.targetPath, plan.repositories.slice(index))
			);
			break;
		}
		planned.push(await createPlannedReport(context.targetPath, repository));
	}
	const interrupted = options.signal?.aborted ?? false;
	const checkouts = [...planned, ...plan.blockedReports, ...plan.retainedReports];
	const hasErrors = checkouts.some((checkout) =>
		checkout.findings.some((finding) => finding.severity === 'error')
	);
	return createCommandReport({
		checkouts,
		command: 'sync',
		dryRun: true,
		exitCode: interrupted ? 130 : hasErrors ? 1 : 0,
		findings: interrupted
			? [
					createFinding(
						'warning',
						'interrupted',
						'Synchronization preview was interrupted; results are partial.'
					),
				]
			: [],
		interrupted,
		targetPath: context.targetPath,
	});
};
