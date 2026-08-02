import type { ArchiveDateState } from './archive-dates.ts';
import type { ManagedCheckout } from './managed-checkout-planning.ts';
import type { CheckoutReport, CommandExitCode, Finding } from './reporting.ts';

import { canonicalCheckoutName } from './checkout-identity.ts';
import { createFinding } from './reporting.ts';

export interface DatesOptions {
	dryRun: boolean;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}

type DatesStatus =
	| 'current'
	| 'skipped:no-commit'
	| 'skipped:not-git'
	| 'skipped:update-failed'
	| 'updated'
	| 'would-update';

export interface DatesDisplayRow {
	name: string;
	newTime: Date;
	oldTime: Date;
	status: DatesStatus;
}

export interface DatesResult {
	checkouts: CheckoutReport[];
	displayRows: DatesDisplayRow[];
	exitCode: CommandExitCode;
	findings: Finding[];
	interrupted: boolean;
}

const formatTable = <T extends Record<string, string>>(
	rows: T[],
	columns: (keyof T & string)[]
): string[] => {
	if (rows.length === 0) return [];
	const widths = columns.map((column) => ({
		name: column,
		width: Math.max(column.length, ...rows.map((row) => String(row[column] ?? '').length)),
	}));
	return [
		widths.map((column) => column.name.padEnd(column.width)).join(' | '),
		widths.map((column) => '-'.repeat(column.width)).join('-+-'),
		...rows.map((row) =>
			widths.map((column) => String(row[column.name] ?? '').padEnd(column.width)).join(' | ')
		),
	];
};

export const createCurrentDateResult = (
	name: string,
	pendingRename: boolean,
	state: ArchiveDateState
): { report: CheckoutReport; row: DatesDisplayRow } => ({
	report: {
		findings: [
			createFinding(
				'info',
				'archive-date-current',
				'Folder timestamp already matches the Archive Date.'
			),
		],
		lifecycle: 'active',
		name,
		outcome: 'current',
		pendingRename,
	},
	row: { name, newTime: state.archiveDate, oldTime: state.currentDate, status: 'current' },
});

export const createDateFailure = (
	name: string,
	lifecycle: CheckoutReport['lifecycle'],
	code: string,
	message: string,
	pendingRename = false
): CheckoutReport => ({
	findings: [createFinding('error', code, message)],
	lifecycle,
	name,
	outcome: 'failed',
	pendingRename,
});

export const createInterruptedDateReports = (checkouts: ManagedCheckout[]): CheckoutReport[] =>
	checkouts.map((checkout) => ({
		findings: [
			createFinding(
				'warning',
				'interrupted-before-date-normalization',
				'Checkout was not processed because interruption was requested.'
			),
		],
		lifecycle: 'active',
		name: checkout.name,
		outcome: 'skipped',
		pendingRename: canonicalCheckoutName(checkout.repositorySlug) !== checkout.name,
	}));

export const createMissingTargetResult = (target: string): DatesResult => ({
	checkouts: [],
	displayRows: [],
	exitCode: 1,
	findings: [createFinding('error', 'target-not-found', `Root path does not exist: ${target}`)],
	interrupted: false,
});

export const createUpdatedDateResult = (
	name: string,
	pendingRename: boolean,
	state: ArchiveDateState,
	dryRun: boolean
): { report: CheckoutReport; row: DatesDisplayRow } => ({
	report: {
		findings: [
			createFinding(
				'info',
				dryRun ? 'date-update-planned' : 'archive-date-updated',
				dryRun
					? `Folder timestamp would be set to Archive Date ${state.archiveDate.toISOString()}.`
					: `Folder timestamp was set to Archive Date ${state.archiveDate.toISOString()}.`
			),
		],
		lifecycle: 'active',
		name,
		outcome: dryRun ? 'skipped' : 'updated',
		pendingRename,
		...(dryRun ? { plannedOutcome: 'updated' as const } : {}),
	},
	row: {
		name,
		newTime: state.archiveDate,
		oldTime: state.currentDate,
		status: dryRun ? 'would-update' : 'updated',
	},
});

export const finalizeDatesResult = (
	checkouts: CheckoutReport[],
	displayRows: DatesDisplayRow[],
	findings: Finding[],
	interrupted: boolean
): DatesResult => {
	const hasErrors =
		findings.some((finding) => finding.severity === 'error') ||
		checkouts.some((checkout) =>
			checkout.findings.some((finding) => finding.severity === 'error')
		);
	const interruptionFinding = interrupted
		? [
				createFinding(
					'warning',
					'interrupted',
					'Date normalization was interrupted; results are partial.'
				),
			]
		: [];
	return {
		checkouts,
		displayRows,
		exitCode: interrupted ? 130 : hasErrors ? 1 : 0,
		findings: [...findings, ...interruptionFinding],
		interrupted,
	};
};

export const formatDatesTables = (rows: DatesDisplayRow[]): string[] => {
	const changed = rows.filter((row) => row.status === 'updated' || row.status === 'would-update');
	const skipped = rows.filter((row) => row.status.startsWith('skipped:'));
	const lines: string[] = [];
	const toTimestampRow = (row: DatesDisplayRow) => ({
		Name: row.name,
		NewTime: row.newTime.toLocaleString(),
		OldTime: row.oldTime.toLocaleString(),
	});
	if (changed.length > 0) {
		const byTime = (left: DatesDisplayRow, right: DatesDisplayRow) =>
			left.newTime.getTime() - right.newTime.getTime();
		const oldest = [...changed].sort(byTime).slice(0, 10).map(toTimestampRow);
		const newest = [...changed]
			.sort((a, b) => byTime(b, a))
			.slice(0, 10)
			.map(toTimestampRow);
		lines.push(
			'',
			'Oldest folder timestamps:',
			...formatTable(oldest, ['Name', 'NewTime', 'OldTime']),
			'',
			'Newest folder timestamps:',
			...formatTable(newest, ['Name', 'NewTime', 'OldTime'])
		);
	}
	if (skipped.length > 0) {
		const skippedRows = skipped.map((row) => ({ Name: row.name, Status: row.status }));
		lines.push('', 'Skipped folders:', ...formatTable(skippedRows, ['Name', 'Status']));
	}
	return lines;
};
