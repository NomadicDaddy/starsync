import fs from 'node:fs';
import path from 'node:path';

import type { DatesDisplayRow, DatesOptions, DatesResult } from './dates-reporting.ts';
import type { ManagedCheckout } from './managed-checkout-planning.ts';
import type { CheckoutReport } from './reporting.ts';

import { inspectArchiveDate, setCheckoutArchiveDate } from './archive-dates.ts';
import { canonicalCheckoutName } from './checkout-identity.ts';
import { discoverDateCheckouts } from './dates-discovery.ts';
import {
	createCurrentDateResult,
	createDateFailure,
	createInterruptedDateReports,
	createMissingTargetResult,
	createUpdatedDateResult,
	finalizeDatesResult,
	formatDatesTables,
} from './dates-reporting.ts';

const readArchiveDateFailure = (
	checkout: ManagedCheckout,
	repoPath: string,
	err: unknown,
): { report: CheckoutReport; row: DatesDisplayRow | null } => {
	const message = err instanceof Error ? err.message : String(err);
	let folderTime: Date | null = null;
	try {
		folderTime = fs.statSync(repoPath).mtime;
	} catch {
		// The checkout-level finding below carries the actionable failure.
	}
	return {
		report: createDateFailure(
			checkout.name,
			'active',
			'archive-date-read-failed',
			`Cannot calculate the Archive Date: ${message}`,
			canonicalCheckoutName(checkout.repositorySlug) !== checkout.name,
		),
		row:
			folderTime === null
				? null
				: {
						name: checkout.name,
						newTime: folderTime,
						oldTime: folderTime,
						status: 'skipped:no-commit',
					},
	};
};

const normalizeCheckout = async (
	target: string,
	checkout: ManagedCheckout,
	dryRun: boolean,
): Promise<{ report: CheckoutReport; row: DatesDisplayRow }> => {
	const repoPath = path.join(target, checkout.name);
	const pendingRename = canonicalCheckoutName(checkout.repositorySlug) !== checkout.name;
	let state;
	try {
		state = await inspectArchiveDate(repoPath);
	} catch (err) {
		const failed = readArchiveDateFailure(checkout, repoPath, err);
		return {
			report: failed.report,
			row:
				failed.row ??
				({
					name: checkout.name,
					newTime: new Date(0),
					oldTime: new Date(0),
					status: 'skipped:no-commit',
				} satisfies DatesDisplayRow),
		};
	}
	if (!state.needsUpdate) return createCurrentDateResult(checkout.name, pendingRename, state);
	if (!dryRun) {
		try {
			setCheckoutArchiveDate(repoPath, state.archiveDate);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				report: createDateFailure(
					checkout.name,
					'active',
					'archive-date-update-failed',
					`Cannot set the folder timestamp to its Archive Date: ${message}`,
					pendingRename,
				),
				row: {
					name: checkout.name,
					newTime: state.archiveDate,
					oldTime: state.currentDate,
					status: 'skipped:update-failed',
				},
			};
		}
	}
	return createUpdatedDateResult(checkout.name, pendingRename, state, dryRun);
};

export const runDatesCommand = async (
	target: string,
	options: DatesOptions,
): Promise<DatesResult> => {
	if (!fs.existsSync(target)) return createMissingTargetResult(target);
	const discovery = await discoverDateCheckouts(target);
	if (discovery.fatalFinding !== null) {
		return finalizeDatesResult(
			discovery.checkouts,
			discovery.displayRows,
			[discovery.fatalFinding],
			false,
		);
	}
	for (const [index, checkout] of discovery.managedCheckouts.entries()) {
		if (options.signal?.aborted) {
			discovery.checkouts.push(
				...createInterruptedDateReports(discovery.managedCheckouts.slice(index)),
			);
			break;
		}
		options.onProgress?.(
			`Normalizing ${index + 1}/${discovery.managedCheckouts.length} — ${checkout.name}`,
		);
		const result = await normalizeCheckout(target, checkout, options.dryRun);
		discovery.checkouts.push(result.report);
		if (result.row.newTime.getTime() !== 0) discovery.displayRows.push(result.row);
	}
	return finalizeDatesResult(
		discovery.checkouts,
		discovery.displayRows,
		[],
		options.signal?.aborted ?? false,
	);
};

export { formatDatesTables };
export type { DatesDisplayRow, DatesResult };
