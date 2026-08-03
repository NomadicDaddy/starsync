import { randomUUID } from 'node:crypto';
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
	rename: {
		proposedName: string;
		repositoryId: number;
		repositorySlug: string;
	} & RenamePreview;
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

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const pathExistsExactly = (targetPath: string): boolean =>
	fs.readdirSync(path.dirname(targetPath)).includes(path.basename(targetPath));

const renameCheckoutPath = (sourcePath: string, destinationPath: string): void => {
	if (pathExistsExactly(destinationPath)) {
		throw new Error('Cannot move checkout folder because its destination is occupied.');
	}
	if (sourcePath.toLowerCase() !== destinationPath.toLowerCase()) {
		fs.renameSync(sourcePath, destinationPath);
		return;
	}
	const temporaryPath = path.join(path.dirname(sourcePath), `.starsync-rename-${randomUUID()}`);
	fs.renameSync(sourcePath, temporaryPath);
	try {
		fs.renameSync(temporaryPath, destinationPath);
	} catch (err) {
		const originalError = err;
		try {
			fs.renameSync(temporaryPath, sourcePath);
		} catch (err) {
			throw new AggregateError(
				[originalError, err],
				`${errorMessage(originalError)} Case-only folder rollback also failed: ${errorMessage(err)}`,
				{ cause: err },
			);
		}
		throw originalError;
	}
};

const failedReport = (checkout: CheckoutReport, err: unknown): CheckoutReport => ({
	...checkout,
	findings: [
		createFinding(
			'error',
			'rename-apply-failed',
			`Cannot apply checkout rename: ${sanitizeMessage(err instanceof Error ? err.message : String(err))}`,
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
	entries: ArchiveEntry[],
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
	renameCheckoutPath(application.entry.path, destination);
	return {
		checkoutPath: destination,
		moved: true,
		originalPath: application.entry.path,
		reportName: application.rename.proposedName,
	};
};

const rollbackCheckoutMove = (moved: MovedCheckout): void => {
	if (!moved.moved) return;
	if (pathExistsExactly(moved.originalPath)) {
		throw new Error(
			'Cannot roll back checkout folder move because its original path is occupied.',
		);
	}
	renameCheckoutPath(moved.checkoutPath, moved.originalPath);
};

const rollbackAfterMetadataFailure = (moved: MovedCheckout, original: unknown): never => {
	try {
		rollbackCheckoutMove(moved);
	} catch (err) {
		throw new AggregateError(
			[original, err],
			`${errorMessage(original)} Folder rollback also failed: ${errorMessage(err)}`,
			{ cause: err },
		);
	}
	throw original;
};

const applyMetadataTransition = async (
	application: ApplicableRename,
	moved: MovedCheckout,
	options: CheckoutRenameApplicationOptions,
): Promise<void> => {
	try {
		await transitionCheckoutState(
			moved.checkoutPath,
			{
				repositoryId: application.rename.repositoryId,
				repositorySlug: application.rename.repositorySlug,
			},
			options.runGit,
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
				`Checkout identity, origin, and folder are current${application.checkout.pendingRename ? ` after renaming ${application.checkout.name}` : ''}.`,
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
	options: CheckoutRenameApplicationOptions = {},
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
