import { Octokit } from '@octokit/rest';
import fs from 'node:fs';

import type { SyncArchiveOptions } from './archive-api.ts';
import type { ArchiveOwner } from './archive-config.ts';
import type { ManagedSyncPlan, StarredRepositoryRecord } from './managed-checkout-planning.ts';
import type { CommandReport } from './reporting.ts';

import { withApiRetry } from './api-retry.ts';
import {
	checkoutExists,
	createInterruptedCheckout,
	getErrorMessage,
	interruptedReport,
	invalidTargetReport,
	maintainCheckoutArchiveDate,
	missingTokenReport,
	operationFailureReport,
	reportRefreshResult,
	resolveExplicitTarget,
} from './archive-api-reporting.ts';
import { partitionValidRepositories, previewSync } from './archive-api-sync-planning.ts';
import { DEFAULT_ARCHIVE_CONCURRENCY } from './archive-api.ts';
import { getAuthenticatedArchiveOwner, readArchiveConfig } from './archive-config.ts';
import { getArchiveModificationFinding } from './archive-migration.ts';
import { planManagedSync } from './managed-checkout-planning.ts';
import { processRepository, runSyncPool } from './refresh.ts';
import { createCommandReport, createFinding } from './reporting.ts';
import { sanitizeMessage } from './secret-safety.ts';

const MAX_ARCHIVE_CONCURRENCY = 8;
const MIN_ARCHIVE_CONCURRENCY = 1;

export interface SyncContext {
	concurrency: number;
	dryRun: boolean;
	targetPath: string;
}

type OwnerResult = { owner: ArchiveOwner } | { report: CommandReport };

const validateSyncOptions = (options: SyncArchiveOptions): CommandReport | SyncContext => {
	const targetPath = resolveExplicitTarget(options.targetPath);
	if (targetPath === null) return invalidTargetReport('sync');
	const dryRun = options.dryRun ?? false;
	if (options.signal?.aborted) return interruptedReport('sync', targetPath, dryRun);
	if (!options.token.trim()) {
		return missingTokenReport('sync', targetPath, 'GITHUB_TOKEN is not set.', dryRun);
	}
	const concurrency = options.concurrency ?? DEFAULT_ARCHIVE_CONCURRENCY;
	if (
		!Number.isInteger(concurrency) ||
		concurrency < MIN_ARCHIVE_CONCURRENCY ||
		concurrency > MAX_ARCHIVE_CONCURRENCY
	) {
		return createCommandReport({
			command: 'sync',
			dryRun,
			exitCode: 2,
			findings: [
				createFinding(
					'error',
					'invalid-concurrency',
					`concurrency must be an integer from ${MIN_ARCHIVE_CONCURRENCY} to ${MAX_ARCHIVE_CONCURRENCY}.`
				),
			],
			targetPath,
		});
	}
	return { concurrency, dryRun, targetPath };
};

const authenticateOwner = async (
	targetPath: string,
	token: string,
	dryRun: boolean
): Promise<OwnerResult> => {
	let configured: ArchiveOwner;
	try {
		configured = readArchiveConfig(targetPath).owner;
	} catch (err) {
		return {
			report: operationFailureReport(
				'sync',
				targetPath,
				'invalid-archive-config',
				`Cannot read archive config: ${sanitizeMessage(getErrorMessage(err))}`,
				dryRun
			),
		};
	}
	let authenticated: ArchiveOwner;
	try {
		authenticated = await getAuthenticatedArchiveOwner(token);
	} catch (err) {
		return {
			report: operationFailureReport(
				'sync',
				targetPath,
				'github-authentication-failed',
				`Cannot authenticate GitHub account: ${sanitizeMessage(getErrorMessage(err))}`,
				dryRun
			),
		};
	}
	if (configured.id === authenticated.id) return { owner: configured };
	return {
		report: operationFailureReport(
			'sync',
			targetPath,
			'archive-owner-mismatch',
			`Archive belongs to GitHub account ${configured.login} (identity ${configured.id}), but the authenticated account is ${authenticated.login} (identity ${authenticated.id}).`,
			dryRun
		),
	};
};

const fetchStarredRepositories = async (
	token: string,
	context: SyncContext
): Promise<CommandReport | StarredRepositoryRecord[]> => {
	const octokit = new Octokit({ auth: token });
	try {
		const response = await withApiRetry(
			() =>
				octokit.paginate(octokit.rest.activity.listReposStarredByAuthenticatedUser, {
					per_page: 100,
				}),
			{ maxRetries: 2 }
		);
		return response.map((repository) => ({
			clone_url: repository.clone_url,
			defaultBranch: repository.default_branch,
			id: repository.id,
			name: repository.name,
			slug: repository.full_name,
		}));
	} catch (err) {
		return operationFailureReport(
			'sync',
			context.targetPath,
			'github-api-failed',
			`Error fetching repositories: ${sanitizeMessage(getErrorMessage(err))}`,
			context.dryRun
		);
	}
};

const loadSyncPlan = async (
	targetPath: string,
	records: StarredRepositoryRecord[],
	dryRun: boolean
): Promise<CommandReport | ManagedSyncPlan> => {
	try {
		return await planManagedSync(targetPath, records);
	} catch (err) {
		return operationFailureReport(
			'sync',
			targetPath,
			'target-read-failed',
			`Cannot inspect managed checkouts: ${sanitizeMessage(getErrorMessage(err))}`,
			dryRun
		);
	}
};

const fetchSyncPlan = async (
	options: SyncArchiveOptions,
	context: SyncContext
): Promise<CommandReport | ManagedSyncPlan> => {
	options.onProgress?.(`Target: ${context.targetPath}`);
	options.onProgress?.('Fetching starred repositories...');
	if (options.signal?.aborted) {
		return interruptedReport('sync', context.targetPath, context.dryRun);
	}
	const records = await fetchStarredRepositories(options.token, context);
	if (!Array.isArray(records)) return records;
	if (options.signal?.aborted) {
		return interruptedReport('sync', context.targetPath, context.dryRun);
	}
	return loadSyncPlan(context.targetPath, records, context.dryRun);
};

const executeSync = async (
	plan: ManagedSyncPlan,
	context: SyncContext,
	owner: ArchiveOwner,
	options: SyncArchiveOptions
): Promise<CommandReport> => {
	const repositories = partitionValidRepositories(context.targetPath, plan.repositories);
	options.onProgress?.(`Concurrency: ${context.concurrency}`);
	const pool = await runSyncPool(
		repositories.valid,
		(repository, interrupted) =>
			processRepository(repository, context.targetPath, interrupted, {
				archiveOwnerId: owner.id,
			}),
		{
			concurrency: context.concurrency,
			onProgress: options.onProgress ?? (() => {}),
			...(options.signal === undefined ? {} : { signal: options.signal }),
			totalCount: repositories.valid.length,
		}
	);
	const refreshed = await Promise.all(
		pool.results.map((result) =>
			maintainCheckoutArchiveDate(
				reportRefreshResult(result, context.targetPath),
				context.targetPath
			)
		)
	);
	const reported = new Set(pool.results.map((result) => result.name));
	const interrupted = pool.interrupted
		? repositories.valid
				.filter((repository) => !reported.has(repository.folderName))
				.map((repository) =>
					createInterruptedCheckout(
						repository.folderName,
						checkoutExists(context.targetPath, repository.folderName) ? 'active' : null,
						'interrupted-before-start',
						'Operation was not scheduled because interruption was requested.',
						repository.pendingRename
					)
				)
		: [];
	const checkouts = [
		...refreshed,
		...interrupted,
		...repositories.invalid,
		...plan.blockedReports,
		...plan.retainedReports,
	];
	const hasErrors = checkouts.some((checkout) =>
		checkout.findings.some((finding) => finding.severity === 'error')
	);
	return createCommandReport({
		checkouts,
		command: 'sync',
		exitCode: pool.interrupted ? 130 : hasErrors ? 1 : 0,
		findings: pool.interrupted
			? [
					createFinding(
						'warning',
						'interrupted',
						'Synchronization was interrupted; results are partial.'
					),
				]
			: [],
		interrupted: pool.interrupted,
		targetPath: context.targetPath,
	});
};

export const syncArchiveUnlocked = async (options: SyncArchiveOptions): Promise<CommandReport> => {
	const context = validateSyncOptions(options);
	if ('schemaVersion' in context) return context;
	const restriction = getArchiveModificationFinding(context.targetPath);
	if (restriction) {
		return createCommandReport({
			command: 'sync',
			dryRun: context.dryRun,
			exitCode: 1,
			findings: [restriction],
			targetPath: context.targetPath,
		});
	}
	const owner = await authenticateOwner(context.targetPath, options.token, context.dryRun);
	if ('report' in owner) return owner.report;
	if (options.signal?.aborted) {
		return interruptedReport('sync', context.targetPath, context.dryRun);
	}
	try {
		if (!context.dryRun) fs.mkdirSync(context.targetPath, { recursive: true });
	} catch (err) {
		return operationFailureReport(
			'sync',
			context.targetPath,
			'target-create-failed',
			`Cannot create target directory: ${getErrorMessage(err)}`,
			context.dryRun
		);
	}
	const plan = await fetchSyncPlan(options, context);
	if ('schemaVersion' in plan) return plan;
	return context.dryRun
		? previewSync(plan, context, options)
		: executeSync(plan, context, owner.owner, options);
};
