import fs from 'node:fs';
import path from 'node:path';

import type { CheckoutReport, CommandExitCode, Finding } from './reporting.ts';

import { ARCHIVE_CONFIG_DIRECTORY } from './archive-config.ts';
import {
	inspectArchiveDate,
	setCheckoutArchiveDate,
	type ArchiveDateState,
} from './archive-dates.ts';
import { canonicalCheckoutName } from './checkout-identity.ts';
import { scanManagedCheckouts } from './managed-checkout-planning.ts';
import { createFinding } from './reporting.ts';

interface DatesOptions {
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
		const oldest = [...changed]
			.sort((a, b) => a.newTime.getTime() - b.newTime.getTime())
			.slice(0, 10)
			.map(toTimestampRow);
		const newest = [...changed]
			.sort((a, b) => b.newTime.getTime() - a.newTime.getTime())
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

const failedCheckout = (
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

export const runDatesCommand = async (
	target: string,
	options: DatesOptions
): Promise<DatesResult> => {
	if (!fs.existsSync(target)) {
		return {
			checkouts: [],
			displayRows: [],
			exitCode: 1,
			findings: [
				createFinding('error', 'target-not-found', `Root path does not exist: ${target}`),
			],
			interrupted: false,
		};
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(target, { withFileTypes: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			checkouts: [],
			displayRows: [],
			exitCode: 1,
			findings: [
				createFinding('error', 'target-read-failed', `Cannot read ${target}: ${message}`),
			],
			interrupted: false,
		};
	}

	const checkouts: CheckoutReport[] = [];
	const displayRows: DatesDisplayRow[] = [];
	const directories = entries.filter(
		(entry) => entry.isDirectory() && entry.name !== ARCHIVE_CONFIG_DIRECTORY
	);
	for (const entry of directories) {
		const checkoutPath = path.join(target, entry.name);
		if (fs.existsSync(path.join(checkoutPath, '.git'))) continue;
		let folderTime: Date;
		try {
			folderTime = fs.statSync(checkoutPath).mtime;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			checkouts.push(
				failedCheckout(
					entry.name,
					null,
					'checkout-stat-failed',
					`Cannot stat ${checkoutPath}: ${message}`
				)
			);
			continue;
		}
		displayRows.push({
			name: entry.name,
			newTime: folderTime,
			oldTime: folderTime,
			status: 'skipped:not-git',
		});
		checkouts.push({
			findings: [createFinding('info', 'not-git-checkout', 'Folder is not a Git checkout.')],
			lifecycle: null,
			name: entry.name,
			outcome: 'skipped',
			pendingRename: false,
		});
	}

	let managedScan: Awaited<ReturnType<typeof scanManagedCheckouts>>;
	try {
		managedScan = await scanManagedCheckouts(target);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			checkouts,
			displayRows,
			exitCode: 1,
			findings: [
				createFinding(
					'error',
					'managed-checkout-scan-failed',
					`Cannot discover managed checkouts: ${message}`
				),
			],
			interrupted: false,
		};
	}
	checkouts.push(...managedScan.reports);

	for (const [index, checkout] of managedScan.checkouts.entries()) {
		const pendingRename = canonicalCheckoutName(checkout.repositorySlug) !== checkout.name;
		if (options.signal?.aborted) {
			for (const interruptedCheckout of managedScan.checkouts.slice(index)) {
				checkouts.push({
					findings: [
						createFinding(
							'warning',
							'interrupted-before-date-normalization',
							'Checkout was not processed because interruption was requested.'
						),
					],
					lifecycle: 'active',
					name: interruptedCheckout.name,
					outcome: 'skipped',
					pendingRename:
						canonicalCheckoutName(interruptedCheckout.repositorySlug) !==
						interruptedCheckout.name,
				});
			}
			break;
		}
		options.onProgress?.(
			`Normalizing ${index + 1}/${managedScan.checkouts.length} — ${checkout.name}`
		);

		const repoPath = path.join(target, checkout.name);
		let state: ArchiveDateState;
		try {
			state = await inspectArchiveDate(repoPath);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			let folderTime: Date | null = null;
			try {
				folderTime = fs.statSync(repoPath).mtime;
			} catch {
				// The checkout-level finding below carries the actionable failure.
			}
			if (folderTime !== null) {
				displayRows.push({
					name: checkout.name,
					newTime: folderTime,
					oldTime: folderTime,
					status: 'skipped:no-commit',
				});
			}
			checkouts.push(
				failedCheckout(
					checkout.name,
					'active',
					'archive-date-read-failed',
					`Cannot calculate the Archive Date: ${message}`,
					pendingRename
				)
			);
			continue;
		}

		if (!state.needsUpdate) {
			displayRows.push({
				name: checkout.name,
				newTime: state.archiveDate,
				oldTime: state.currentDate,
				status: 'current',
			});
			checkouts.push({
				findings: [
					createFinding(
						'info',
						'archive-date-current',
						'Folder timestamp already matches the Archive Date.'
					),
				],
				lifecycle: 'active',
				name: checkout.name,
				outcome: 'current',
				pendingRename,
			});
			continue;
		}

		if (!options.dryRun) {
			try {
				setCheckoutArchiveDate(repoPath, state.archiveDate);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				displayRows.push({
					name: checkout.name,
					newTime: state.archiveDate,
					oldTime: state.currentDate,
					status: 'skipped:update-failed',
				});
				checkouts.push(
					failedCheckout(
						checkout.name,
						'active',
						'archive-date-update-failed',
						`Cannot set the folder timestamp to its Archive Date: ${message}`,
						pendingRename
					)
				);
				continue;
			}
		}
		displayRows.push({
			name: checkout.name,
			newTime: state.archiveDate,
			oldTime: state.currentDate,
			status: options.dryRun ? 'would-update' : 'updated',
		});
		checkouts.push({
			findings: [
				createFinding(
					'info',
					options.dryRun ? 'date-update-planned' : 'archive-date-updated',
					options.dryRun
						? `Folder timestamp would be set to Archive Date ${state.archiveDate.toISOString()}.`
						: `Folder timestamp was set to Archive Date ${state.archiveDate.toISOString()}.`
				),
			],
			lifecycle: 'active',
			name: checkout.name,
			outcome: options.dryRun ? 'skipped' : 'updated',
			pendingRename,
			...(options.dryRun ? { plannedOutcome: 'updated' as const } : {}),
		});
	}

	const hasErrors = checkouts.some((checkout) =>
		checkout.findings.some((finding) => finding.severity === 'error')
	);
	const interrupted = options.signal?.aborted ?? false;
	return {
		checkouts,
		displayRows,
		exitCode: interrupted ? 130 : hasErrors ? 1 : 0,
		findings: interrupted
			? [
					createFinding(
						'warning',
						'interrupted',
						'Date normalization was interrupted; results are partial.'
					),
				]
			: [],
		interrupted,
	};
};
