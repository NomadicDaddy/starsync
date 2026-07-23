import { Octokit } from '@octokit/rest';
import fs from 'node:fs';
import path from 'node:path';

import type { ArchiveOwner } from './archive-config.ts';
import type { CheckoutReport, CommandReport, Finding } from './reporting.ts';

import { withApiRetry } from './api-retry.ts';
import { getAuthenticatedArchiveOwner, readArchiveConfig } from './archive-config.ts';
import { inspectArchiveDate, setCheckoutArchiveDate } from './archive-dates.ts';
import { initArchiveUnlocked, type InitArchiveOptions } from './archive-initialization.ts';
import { applyArchiveMigration } from './archive-migration-apply.ts';
import {
	createGitHubRepositoryResolver,
	getArchiveModificationFinding,
	previewArchiveMigration,
} from './archive-migration.ts';
import { withArchiveOperationLock } from './archive-operation-lock.ts';
import { unlockArchive, type UnlockArchiveOptions } from './archive-unlock.ts';
import { verifyArchive as verifyArchiveContents } from './archive-verification.ts';
import { formatDatesTables, runDatesCommand } from './dates-command.ts';
import {
	planManagedSync,
	type ManagedSyncPlan,
	type StarredRepositoryRecord,
} from './managed-checkout-planning.ts';
import { processRepository, runSyncPool, type RefreshResult } from './refresh.ts';
import { createCommandReport, createFinding } from './reporting.ts';
import { isGitHubDotComUrl, sanitizeMessage, sanitizeUrl } from './secret-safety.ts';

export const DEFAULT_ARCHIVE_CONCURRENCY = 4;
const MAX_ARCHIVE_CONCURRENCY = 8;
const MIN_ARCHIVE_CONCURRENCY = 1;

export type ArchiveProgressCallback = (message: string) => void;

export interface ArchiveOperationOptions {
	onProgress?: ArchiveProgressCallback;
	signal?: AbortSignal;
	targetPath: string;
}

export interface MigrateArchiveOptions extends ArchiveOperationOptions {
	apply?: boolean;
	token: string;
}

export interface NormalizeArchiveDatesOptions extends ArchiveOperationOptions {
	dryRun?: boolean;
}

export interface SyncArchiveOptions extends ArchiveOperationOptions {
	concurrency?: number;
	dryRun?: boolean;
	token: string;
}

export type VerifyArchiveOptions = ArchiveOperationOptions;

const getErrorMessage = (err: unknown): string =>
	err instanceof Error ? err.message : String(err);

const resolveExplicitTarget = (targetPath: string): null | string => {
	const trimmed = targetPath.trim();
	return trimmed ? path.resolve(trimmed) : null;
};

const invalidTargetReport = (command: CommandReport['command']): CommandReport =>
	createCommandReport({
		command,
		exitCode: 2,
		findings: [
			createFinding('error', 'invalid-target', 'targetPath must be a non-empty string.'),
		],
		targetPath: null,
	});

const interruptedReport = (
	command: CommandReport['command'],
	targetPath: string,
	dryRun = false
): CommandReport =>
	createCommandReport({
		command,
		dryRun,
		exitCode: 130,
		findings: [
			createFinding('warning', 'interrupted', 'Operation was interrupted before it started.'),
		],
		interrupted: true,
		targetPath,
	});

const missingTokenReport = (
	command: 'migrate' | 'sync',
	targetPath: string,
	message: string,
	dryRun = false
): CommandReport =>
	createCommandReport({
		command,
		dryRun,
		exitCode: 1,
		findings: [createFinding('error', 'missing-token', message)],
		targetPath,
	});

const checkoutExists = (targetBase: string, name: string): boolean =>
	fs.existsSync(path.join(targetBase, name, '.git'));

const invalidArchiveConfigReport = (
	command: 'sync',
	targetPath: string,
	err: unknown
): CommandReport =>
	createCommandReport({
		command,
		exitCode: 1,
		findings: [
			createFinding(
				'error',
				'invalid-archive-config',
				`Cannot read archive config: ${sanitizeMessage(getErrorMessage(err))}`
			),
		],
		targetPath,
	});

const reportRefreshResult = (result: RefreshResult, targetBase: string): CheckoutReport => {
	const lifecycle = checkoutExists(targetBase, result.name) ? 'active' : null;
	const pendingRename = result.pendingRename ?? false;
	switch (result.outcome) {
		case 'added':
			return {
				findings: [],
				lifecycle: 'active',
				name: result.name,
				outcome: 'added',
				pendingRename,
			};
		case 'blocked':
			return {
				findings: [
					createFinding(
						'error',
						'checkout-blocked',
						result.message ?? 'Local state would be overwritten.'
					),
				],
				lifecycle: 'blocked',
				name: result.name,
				outcome: 'failed',
				pendingRename,
			};
		case 'current':
			return {
				findings: [createFinding('info', 'checkout-current', 'Checkout is current.')],
				lifecycle: 'active',
				name: result.name,
				outcome: 'current',
				pendingRename,
			};
		case 'failed':
			return {
				findings: [
					createFinding(
						'error',
						'git-operation-failed',
						result.message ?? 'Unknown Git error.'
					),
				],
				lifecycle,
				name: result.name,
				outcome: 'failed',
				pendingRename,
			};
		case 'retained':
			return {
				findings: [
					createFinding(
						'info',
						'checkout-retained',
						'Checkout is no longer starred and was retained.'
					),
				],
				lifecycle: 'retained',
				name: result.name,
				outcome: 'skipped',
				pendingRename,
			};
		case 'skipped':
			return {
				findings: [
					createFinding(
						'warning',
						'operation-skipped',
						result.message ?? 'Operation was skipped.'
					),
				],
				lifecycle,
				name: result.name,
				outcome: 'skipped',
				pendingRename,
			};
		case 'updated':
			return {
				findings: [],
				lifecycle: 'active',
				name: result.name,
				outcome: 'updated',
				pendingRename,
			};
	}
};

const maintainCheckoutArchiveDate = async (
	report: CheckoutReport,
	targetPath: string
): Promise<CheckoutReport> => {
	if (!['added', 'current', 'updated'].includes(report.outcome)) return report;

	try {
		const checkoutPath = path.join(targetPath, report.name);
		const state = await inspectArchiveDate(checkoutPath);
		if (!state.needsUpdate) return report;
		setCheckoutArchiveDate(checkoutPath, state.archiveDate);
		return {
			...report,
			findings: [
				...report.findings,
				createFinding(
					'info',
					'archive-date-updated',
					`Folder timestamp was set to Archive Date ${state.archiveDate.toISOString()}.`
				),
			],
		};
	} catch (err) {
		return {
			...report,
			findings: [
				...report.findings,
				createFinding(
					'error',
					'archive-date-update-failed',
					`Git operation succeeded, but the folder timestamp could not be aligned with its Archive Date: ${sanitizeMessage(
						getErrorMessage(err)
					)}`
				),
			],
		};
	}
};

const syncArchiveUnlocked = async (options: SyncArchiveOptions): Promise<CommandReport> => {
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

	const archiveRestriction = getArchiveModificationFinding(targetPath);
	if (archiveRestriction) {
		return createCommandReport({
			command: 'sync',
			dryRun,
			exitCode: 1,
			findings: [archiveRestriction],
			targetPath,
		});
	}

	let configuredOwner: ArchiveOwner;
	try {
		configuredOwner = readArchiveConfig(targetPath).owner;
	} catch (err) {
		return invalidArchiveConfigReport('sync', targetPath, err);
	}

	let authenticatedOwner: ArchiveOwner;
	try {
		authenticatedOwner = await getAuthenticatedArchiveOwner(options.token);
	} catch (err) {
		return createCommandReport({
			command: 'sync',
			dryRun,
			exitCode: 1,
			findings: [
				createFinding(
					'error',
					'github-authentication-failed',
					`Cannot authenticate GitHub account: ${sanitizeMessage(getErrorMessage(err))}`
				),
			],
			targetPath,
		});
	}
	if (configuredOwner.id !== authenticatedOwner.id) {
		return createCommandReport({
			command: 'sync',
			dryRun,
			exitCode: 1,
			findings: [
				createFinding(
					'error',
					'archive-owner-mismatch',
					`Archive belongs to GitHub account ${configuredOwner.login} (identity ${configuredOwner.id}), but the authenticated account is ${authenticatedOwner.login} (identity ${authenticatedOwner.id}).`
				),
			],
			targetPath,
		});
	}
	if (options.signal?.aborted) return interruptedReport('sync', targetPath, dryRun);

	try {
		if (!dryRun) fs.mkdirSync(targetPath, { recursive: true });
	} catch (err) {
		return createCommandReport({
			command: 'sync',
			dryRun,
			exitCode: 1,
			findings: [
				createFinding(
					'error',
					'target-create-failed',
					`Cannot create target directory: ${getErrorMessage(err)}`
				),
			],
			targetPath,
		});
	}

	options.onProgress?.(`Target: ${targetPath}`);
	options.onProgress?.('Fetching starred repositories...');
	if (options.signal?.aborted) return interruptedReport('sync', targetPath, dryRun);
	const octokit = new Octokit({ auth: options.token });
	let repositoryRecords: StarredRepositoryRecord[];
	try {
		const response = await withApiRetry(
			() =>
				octokit.paginate(octokit.rest.activity.listReposStarredByAuthenticatedUser, {
					per_page: 100,
				}),
			{ maxRetries: 2 }
		);
		repositoryRecords = response.map((repository) => ({
			clone_url: repository.clone_url,
			id: repository.id,
			name: repository.name,
			slug: repository.full_name,
		}));
	} catch (err) {
		return createCommandReport({
			command: 'sync',
			dryRun,
			exitCode: 1,
			findings: [
				createFinding(
					'error',
					'github-api-failed',
					`Error fetching repositories: ${sanitizeMessage(getErrorMessage(err))}`
				),
			],
			targetPath,
		});
	}

	if (options.signal?.aborted) return interruptedReport('sync', targetPath, dryRun);

	let syncPlan: ManagedSyncPlan;
	try {
		syncPlan = await planManagedSync(targetPath, repositoryRecords);
	} catch (err) {
		return createCommandReport({
			command: 'sync',
			dryRun,
			exitCode: 1,
			findings: [
				createFinding(
					'error',
					'target-read-failed',
					`Cannot inspect managed checkouts: ${sanitizeMessage(getErrorMessage(err))}`
				),
			],
			targetPath,
		});
	}
	const { blockedReports, repositories, retainedReports } = syncPlan;
	if (blockedReports.length > 0 && repositories.length === 0) {
		return createCommandReport({
			checkouts: blockedReports,
			command: 'sync',
			dryRun,
			exitCode: 1,
			targetPath,
		});
	}

	if (dryRun) {
		options.onProgress?.('Dry run: querying stars and inspecting the archive without changes.');
		const plannedReports: CheckoutReport[] = [];
		for (const [index, repository] of repositories.entries()) {
			const appendInterruptedReports = () => {
				plannedReports.push(
					...repositories.slice(index).map((interruptedRepository): CheckoutReport => ({
						findings: [
							createFinding(
								'warning',
								'interrupted-before-inspection',
								'Repository was not inspected because interruption was requested.'
							),
						],
						lifecycle: checkoutExists(targetPath, interruptedRepository.folderName)
							? 'active'
							: null,
						name: interruptedRepository.folderName,
						outcome: 'skipped',
						pendingRename: interruptedRepository.pendingRename,
					}))
				);
			};
			if (options.signal?.aborted) {
				appendInterruptedReports();
				break;
			}
			const isCloned = checkoutExists(targetPath, repository.folderName);
			const plannedOutcome = isCloned ? 'updated' : 'added';
			options.onProgress?.(
				`Syncing ${index + 1}/${repositories.length} — ${repository.folderName} — would ${isCloned ? 'refresh' : 'clone'}`
			);
			if (options.signal?.aborted) {
				appendInterruptedReports();
				break;
			}
			const findings = [
				createFinding(
					'info',
					isCloned ? 'refresh-planned' : 'clone-planned',
					isCloned ? 'Checkout would be refreshed.' : 'Repository would be added.'
				),
			];
			if (isCloned) {
				try {
					const state = await inspectArchiveDate(
						path.join(targetPath, repository.folderName)
					);
					if (state.needsUpdate) {
						findings.push(
							createFinding(
								'info',
								'date-update-planned',
								`Folder timestamp would be set to Archive Date ${state.archiveDate.toISOString()}.`
							)
						);
					}
				} catch (err) {
					findings.push(
						createFinding(
							'error',
							'archive-date-read-failed',
							`Cannot calculate the planned Archive Date: ${sanitizeMessage(
								getErrorMessage(err)
							)}`
						)
					);
				}
			} else {
				findings.push(
					createFinding(
						'info',
						'date-update-planned',
						'After cloning, the folder timestamp would be set to its Archive Date.'
					)
				);
			}
			plannedReports.push({
				findings,
				lifecycle: isCloned ? 'active' : null,
				name: repository.folderName,
				outcome: 'skipped',
				pendingRename: repository.pendingRename,
				plannedOutcome,
			});
		}
		const interrupted = options.signal?.aborted ?? false;
		const hasErrors = [...plannedReports, ...blockedReports].some((checkout) =>
			checkout.findings.some((finding) => finding.severity === 'error')
		);
		return createCommandReport({
			checkouts: [...plannedReports, ...blockedReports, ...retainedReports],
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
			targetPath,
		});
	}

	const validRepositories: typeof repositories = [];
	const invalidReports: CheckoutReport[] = [];
	for (const repository of repositories) {
		if (!isGitHubDotComUrl(repository.clone_url)) {
			invalidReports.push({
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
		} else {
			validRepositories.push(repository);
		}
	}

	options.onProgress?.(`Concurrency: ${concurrency}`);
	const poolResult = await runSyncPool(
		validRepositories,
		(repository, isInterruptionRequested) =>
			processRepository(repository, targetPath, isInterruptionRequested, {
				archiveOwnerId: configuredOwner.id,
			}),
		{
			concurrency,
			onProgress: options.onProgress ?? (() => {}),
			...(options.signal === undefined ? {} : { signal: options.signal }),
			totalCount: validRepositories.length,
		}
	);
	const refreshReports = await Promise.all(
		poolResult.results.map((result) =>
			maintainCheckoutArchiveDate(reportRefreshResult(result, targetPath), targetPath)
		)
	);
	const reportedNames = new Set(poolResult.results.map((result) => result.name));
	const interruptedReports = poolResult.interrupted
		? validRepositories
				.filter((repository) => !reportedNames.has(repository.folderName))
				.map((repository): CheckoutReport => ({
					findings: [
						createFinding(
							'warning',
							'interrupted-before-start',
							'Operation was not scheduled because interruption was requested.'
						),
					],
					lifecycle: checkoutExists(targetPath, repository.folderName) ? 'active' : null,
					name: repository.folderName,
					outcome: 'skipped',
					pendingRename: repository.pendingRename,
				}))
		: [];
	const checkouts = [
		...refreshReports,
		...interruptedReports,
		...invalidReports,
		...blockedReports,
		...retainedReports,
	];
	const findings: Finding[] = poolResult.interrupted
		? [
				createFinding(
					'warning',
					'interrupted',
					'Synchronization was interrupted; results are partial.'
				),
			]
		: [];
	const hasErrors = checkouts.some((checkout) =>
		checkout.findings.some((finding) => finding.severity === 'error')
	);
	return createCommandReport({
		checkouts,
		command: 'sync',
		exitCode: poolResult.interrupted ? 130 : hasErrors ? 1 : 0,
		findings,
		interrupted: poolResult.interrupted,
		targetPath,
	});
};

const verifyArchiveUnlocked = async (options: VerifyArchiveOptions): Promise<CommandReport> => {
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
		return createCommandReport({
			command: 'verify',
			exitCode: 1,
			findings: [
				createFinding(
					'error',
					'archive-verification-failed',
					`Archive verification failed: ${sanitizeMessage(getErrorMessage(err))}`
				),
			],
			targetPath,
		});
	}
};

const migrateArchiveUnlocked = async (options: MigrateArchiveOptions): Promise<CommandReport> => {
	const targetPath = resolveExplicitTarget(options.targetPath);
	if (targetPath === null) return invalidTargetReport('migrate');
	const apply = options.apply ?? false;
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
			: await previewArchiveMigration(targetPath, resolver, {
					isInterruptionRequested: () => options.signal?.aborted ?? false,
					...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
				});
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
		return createCommandReport({
			command: 'migrate',
			dryRun: !apply,
			exitCode: 1,
			findings: [
				createFinding(
					'error',
					apply ? 'migration-apply-failed' : 'migration-preview-failed',
					`Migration ${apply ? 'application' : 'preview'} failed: ${sanitizeMessage(getErrorMessage(err))}`
				),
			],
			targetPath,
		});
	}
};

const normalizeArchiveDatesUnlocked = async (
	options: NormalizeArchiveDatesOptions
): Promise<CommandReport> => {
	const targetPath = resolveExplicitTarget(options.targetPath);
	if (targetPath === null) return invalidTargetReport('dates');
	const dryRun = options.dryRun ?? false;
	if (options.signal?.aborted) return interruptedReport('dates', targetPath, dryRun);

	const archiveRestriction = getArchiveModificationFinding(targetPath);
	if (archiveRestriction) {
		return createCommandReport({
			command: 'dates',
			dryRun,
			exitCode: 1,
			findings: [archiveRestriction],
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

export const initArchive = (options: InitArchiveOptions): Promise<CommandReport> =>
	withArchiveOperationLock('init', options, (held) => initArchiveUnlocked(options, held));

export const syncArchive = (options: SyncArchiveOptions): Promise<CommandReport> =>
	withArchiveOperationLock(
		'sync',
		options,
		() => syncArchiveUnlocked(options),
		options.dryRun ?? false
	);

export const verifyArchive = (options: VerifyArchiveOptions): Promise<CommandReport> =>
	withArchiveOperationLock('verify', options, () => verifyArchiveUnlocked(options));

export const migrateArchive = (options: MigrateArchiveOptions): Promise<CommandReport> =>
	withArchiveOperationLock(
		'migrate',
		options,
		() => migrateArchiveUnlocked(options),
		!(options.apply ?? false)
	);

export const normalizeArchiveDates = (
	options: NormalizeArchiveDatesOptions
): Promise<CommandReport> =>
	withArchiveOperationLock(
		'dates',
		options,
		() => normalizeArchiveDatesUnlocked(options),
		options.dryRun ?? false
	);

export { unlockArchive };
export type { InitArchiveOptions, UnlockArchiveOptions };
