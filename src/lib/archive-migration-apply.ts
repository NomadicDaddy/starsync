import fs from 'node:fs';
import path from 'node:path';

import type { ArchiveOwner } from './archive-config.ts';
import type {
	MigrationPreviewOptions,
	MigrationPreviewResult,
	RepositoryResolver,
} from './archive-migration.ts';
import type { ArchiveInspection } from './archive-migration.ts';
import type { CheckoutReport } from './reporting.ts';

import { writeMigratedArchiveConfig } from './archive-config.ts';
import { getMigrationStatePath, prepareMigrationState } from './archive-migration-state.ts';
import {
	inspectArchive,
	parseGitHubRepositorySlug,
	previewArchiveMigration,
} from './archive-migration.ts';
import {
	readCheckoutIdentity,
	updateCheckoutOrigin,
	writeCheckoutIdentity,
} from './checkout-identity.ts';
import { createFinding } from './reporting.ts';
import { sanitizeMessage } from './secret-safety.ts';

const originMatchesSlug = (origin: null | string, slug: string): boolean => {
	if (origin === null) return false;
	const parsed = parseGitHubRepositorySlug(origin);
	return (
		parsed !== null &&
		`${parsed.owner}/${parsed.repository}`.toLowerCase() === slug.toLowerCase()
	);
};

const appliedBlockedReport = (checkout: CheckoutReport): CheckoutReport => ({
	...checkout,
	findings: [
		createFinding(
			'warning',
			'adopted-but-blocked',
			checkout.pendingRename
				? 'Checkout identity was recorded, but local state prevents the pending folder rename.'
				: 'Checkout identity was recorded, but local state remains blocked.'
		),
	],
	outcome: 'updated',
});

const failedApplicationReport = (checkout: CheckoutReport, err: unknown): CheckoutReport => ({
	...checkout,
	findings: [
		createFinding(
			'error',
			'migration-apply-failed',
			`Cannot apply checkout migration: ${sanitizeMessage(
				err instanceof Error ? err.message : String(err)
			)}`
		),
	],
	lifecycle: 'blocked',
	outcome: 'failed',
});

const applyCheckout = async (
	targetPath: string,
	inspection: ArchiveInspection,
	checkout: CheckoutReport
): Promise<{ applied: boolean; report: CheckoutReport }> => {
	const migration = checkout.migration;
	if (
		migration === undefined ||
		migration.repositoryId === null ||
		migration.repositorySlug === null ||
		migration.proposedName === null ||
		migration.classification === 'failed'
	) {
		return { applied: false, report: checkout };
	}

	const entry = inspection.entries.find((candidate) => candidate.name === checkout.name);
	if (!entry?.isGitCheckout) return { applied: false, report: checkout };
	try {
		const identity = {
			repositoryId: migration.repositoryId,
			repositorySlug: migration.repositorySlug,
		};
		const existingIdentity = await readCheckoutIdentity(entry.path).catch(() => null);
		if (
			existingIdentity?.repositoryId !== identity.repositoryId ||
			existingIdentity.repositorySlug !== identity.repositorySlug
		) {
			await writeCheckoutIdentity(entry.path, identity);
		}

		if (migration.classification === 'adopted-but-blocked') {
			return { applied: true, report: appliedBlockedReport(checkout) };
		}

		let checkoutPath = entry.path;
		let reportName = checkout.name;
		if (checkout.pendingRename) {
			const destination = path.join(targetPath, migration.proposedName);
			fs.renameSync(entry.path, destination);
			checkoutPath = destination;
			reportName = migration.proposedName;
		}
		if (!originMatchesSlug(entry.origin, migration.repositorySlug)) {
			await updateCheckoutOrigin(checkoutPath, migration.repositorySlug);
		}

		const changed =
			existingIdentity?.repositoryId !== identity.repositoryId ||
			existingIdentity.repositorySlug !== identity.repositorySlug ||
			checkout.pendingRename ||
			!originMatchesSlug(entry.origin, migration.repositorySlug);
		return {
			applied: true,
			report: {
				...checkout,
				findings: [
					createFinding(
						'info',
						changed ? 'checkout-migrated' : 'checkout-migration-current',
						changed
							? `Checkout migration applied${checkout.pendingRename ? ` from ${checkout.name}` : ''}.`
							: 'Checkout identity and canonical folder are already current.'
					),
				],
				name: reportName,
				outcome: changed ? 'updated' : 'current',
				pendingRename: false,
			},
		};
	} catch (err) {
		return { applied: false, report: failedApplicationReport(checkout, err) };
	}
};

export const applyArchiveMigration = async (
	targetPath: string,
	resolveRepository: RepositoryResolver,
	authenticatedOwner: ArchiveOwner,
	options: MigrationPreviewOptions = {}
): Promise<MigrationPreviewResult> => {
	const inspection = inspectArchive(targetPath);
	if (
		inspection.kind === 'invalid' ||
		inspection.kind === 'newer-managed' ||
		inspection.kind === 'uninitialized'
	) {
		return previewArchiveMigration(targetPath, resolveRepository, options);
	}

	const stateFinding = prepareMigrationState(targetPath, inspection, authenticatedOwner);
	if (stateFinding !== null) {
		return {
			checkouts: [],
			exitCode: 1,
			findings: [...inspection.findings, stateFinding],
			interrupted: false,
		};
	}

	const preview = await previewArchiveMigration(targetPath, resolveRepository, options);
	if (preview.interrupted) return preview;

	const reports: CheckoutReport[] = [];
	let complete = true;
	for (const [index, checkout] of preview.checkouts.entries()) {
		if (options.isInterruptionRequested?.()) {
			complete = false;
			reports.push(
				...preview.checkouts.slice(index).map((remaining) => ({
					...remaining,
					findings: [
						createFinding(
							'warning',
							'interrupted-before-apply',
							'Checkout migration was not applied because interruption was requested.'
						),
					],
					outcome: 'skipped' as const,
				}))
			);
			break;
		}
		options.onProgress?.(
			`Applying ${index + 1}/${preview.checkouts.length} — ${checkout.name}`
		);
		const applied = await applyCheckout(targetPath, inspection, checkout);
		reports.push(applied.report);
		complete &&= applied.applied;
	}

	const interrupted = options.isInterruptionRequested?.() ?? false;
	if (complete && !interrupted) {
		try {
			if (inspection.kind !== 'current-managed') {
				writeMigratedArchiveConfig(targetPath, authenticatedOwner);
			}
			fs.rmSync(getMigrationStatePath(targetPath), { force: true });
		} catch (err) {
			complete = false;
			preview.findings.push(
				createFinding(
					'error',
					'archive-format-update-failed',
					`Checkout identities were recorded, but the archive format could not be finalized: ${sanitizeMessage(
						err instanceof Error ? err.message : String(err)
					)}`
				)
			);
		}
	}

	const findings = [
		...preview.findings,
		createFinding(
			interrupted ? 'warning' : complete ? 'info' : 'error',
			interrupted ? 'interrupted' : complete ? 'migration-completed' : 'migration-partial',
			interrupted
				? 'Migration was interrupted; completed checkout changes were preserved.'
				: complete
					? 'Managed checkout migration completed.'
					: 'Migration is incomplete; successful checkout changes were preserved for the next run.'
		),
	];
	return {
		checkouts: reports,
		exitCode: interrupted ? 130 : complete ? 0 : 1,
		findings,
		interrupted,
	};
};
