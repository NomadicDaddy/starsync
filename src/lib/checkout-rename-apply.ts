import fs from 'node:fs';
import path from 'node:path';

import type { ArchiveEntry } from './archive-inspection.ts';
import type { CheckoutStateRunner } from './checkout-state-transition.ts';
import type { CheckoutReport, RenamePreview } from './reporting.ts';

import { readCheckoutIdentity } from './checkout-identity.ts';
import { transitionCheckoutState } from './checkout-state-transition.ts';
import { createFinding } from './reporting.ts';
import { sanitizeMessage } from './secret-safety.ts';

interface ApplicableRename {
	checkout: CheckoutReport;
	entry: ArchiveEntry;
	rename: RenamePreview & {
		proposedName: string;
		repositoryId: number;
		repositorySlug: string;
	};
}

export interface CheckoutRenameApplication {
	applied: boolean;
	report: CheckoutReport;
}

export interface CheckoutRenameApplicationOptions {
	runGit?: CheckoutStateRunner;
}

interface MovedCheckout {
	checkoutPath: string;
	moved: boolean;
	originalPath: string;
	reportName: string;
}

const failedReport = (checkout: CheckoutReport, err: unknown): CheckoutReport => ({
	...checkout,
	findings: [
		createFinding(
			'error',
			'rename-apply-failed',
			`Cannot apply checkout rename: ${sanitizeMessage(err instanceof Error ? err.message : String(err))}`
		),
	],
	lifecycle: 'blocked',
	outcome: 'failed',
	...(checkout.rename === undefined
		? {}
		: { rename: { ...checkout.rename, classification: 'failed' as const } }),
});

const selectApplicableRename = (
	checkout: CheckoutReport,
	entries: ArchiveEntry[]
): ApplicableRename | CheckoutRenameApplication => {
	const rename = checkout.rename;
	if (rename?.classification === 'current') return { applied: true, report: checkout };
	if (rename?.classification !== 'pending') return { applied: false, report: checkout };
	if (
		rename.repositoryId === null ||
		rename.repositorySlug === null ||
		rename.proposedName === null
	) {
		return { applied: false, report: checkout };
	}
	const entry = entries.find((candidate) => candidate.name === checkout.name);
	if (!entry?.isGitCheckout) return { applied: false, report: checkout };
	return {
		checkout,
		entry,
		rename: {
			...rename,
			proposedName: rename.proposedName,
			repositoryId: rename.repositoryId,
			repositorySlug: rename.repositorySlug,
		},
	};
};

const moveCheckout = (targetPath: string, application: ApplicableRename): MovedCheckout => {
	if (!application.checkout.pendingRename) {
		return {
			checkoutPath: application.entry.path,
			moved: false,
			originalPath: application.entry.path,
			reportName: application.checkout.name,
		};
	}
	const destination = path.join(targetPath, application.rename.proposedName);
	fs.renameSync(application.entry.path, destination);
	return {
		checkoutPath: destination,
		moved: true,
		originalPath: application.entry.path,
		reportName: application.rename.proposedName,
	};
};

const rollbackCheckoutMove = (moved: MovedCheckout): void => {
	if (!moved.moved) return;
	if (fs.existsSync(moved.originalPath)) {
		throw new Error(
			'Cannot roll back checkout folder move because its original path is occupied.'
		);
	}
	fs.renameSync(moved.checkoutPath, moved.originalPath);
};

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const rollbackAfterMetadataFailure = (moved: MovedCheckout, original: unknown): never => {
	try {
		rollbackCheckoutMove(moved);
	} catch (err) {
		throw new AggregateError(
			[original, err],
			`${errorMessage(original)} Folder rollback also failed: ${errorMessage(err)}`,
			{ cause: err }
		);
	}
	throw original;
};

const applyMetadataTransition = async (
	application: ApplicableRename,
	moved: MovedCheckout,
	options: CheckoutRenameApplicationOptions
): Promise<void> => {
	try {
		await transitionCheckoutState(
			moved.checkoutPath,
			{
				repositoryId: application.rename.repositoryId,
				repositorySlug: application.rename.repositorySlug,
			},
			options.runGit
		);
	} catch (err) {
		rollbackAfterMetadataFailure(moved, err);
	}
};

const appliedReport = (application: ApplicableRename, reportName: string): CheckoutReport => {
	const report: CheckoutReport = { ...application.checkout };
	delete report.plannedOutcome;
	return {
		...report,
		findings: [
			createFinding(
				'info',
				'rename-applied',
				`Checkout identity, origin, and folder are current${application.checkout.pendingRename ? ` after renaming ${application.checkout.name}` : ''}.`
			),
		],
		name: reportName,
		outcome: 'updated',
		pendingRename: false,
		rename: { ...application.rename, classification: 'current' },
	};
};

export const applyCheckoutRename = async (
	targetPath: string,
	checkout: CheckoutReport,
	entries: ArchiveEntry[],
	options: CheckoutRenameApplicationOptions = {}
): Promise<CheckoutRenameApplication> => {
	const selected = selectApplicableRename(checkout, entries);
	if ('applied' in selected) return selected;
	try {
		const identity = await readCheckoutIdentity(selected.entry.path);
		if (identity?.repositoryId !== selected.rename.repositoryId) {
			throw new Error('Stored repository identity changed after the rename preview.');
		}
		const moved = moveCheckout(targetPath, selected);
		await applyMetadataTransition(selected, moved, options);
		return { applied: true, report: appliedReport(selected, moved.reportName) };
	} catch (err) {
		return { applied: false, report: failedReport(checkout, err) };
	}
};
