import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { CheckoutReport, CommandExitCode, Finding } from './reporting.ts';

import { createFinding } from './reporting.ts';

interface DatesOptions {
	dryRun: boolean;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}

type DatesStatus = 'skipped:no-commit' | 'skipped:not-git' | 'updated' | 'would-update';

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
	const skipped = rows.filter((row) => row.status !== 'updated' && row.status !== 'would-update');
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
	message: string
): CheckoutReport => ({
	findings: [createFinding('error', code, message)],
	lifecycle,
	name,
	outcome: 'failed',
	pendingRename: false,
});

export const runDatesCommand = (target: string, options: DatesOptions): DatesResult => {
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
	const directories = entries.filter((entry) => entry.isDirectory());
	for (const [index, entry] of directories.entries()) {
		if (options.signal?.aborted) {
			for (const interruptedEntry of directories.slice(index)) {
				checkouts.push({
					findings: [
						createFinding(
							'warning',
							'interrupted-before-date-normalization',
							'Checkout was not processed because interruption was requested.'
						),
					],
					lifecycle: fs.existsSync(path.join(target, interruptedEntry.name, '.git'))
						? 'active'
						: null,
					name: interruptedEntry.name,
					outcome: 'skipped',
					pendingRename: false,
				});
			}
			break;
		}
		options.onProgress?.(`Normalizing ${index + 1}/${directories.length} — ${entry.name}`);

		const repoPath = path.join(target, entry.name);
		let oldTime: Date;
		try {
			oldTime = fs.statSync(repoPath).mtime;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			checkouts.push(
				failedCheckout(
					entry.name,
					null,
					'checkout-stat-failed',
					`Cannot stat ${repoPath}: ${message}`
				)
			);
			continue;
		}

		if (!fs.existsSync(path.join(repoPath, '.git'))) {
			displayRows.push({
				name: entry.name,
				newTime: oldTime,
				oldTime,
				status: 'skipped:not-git',
			});
			checkouts.push({
				findings: [
					createFinding('info', 'not-git-checkout', 'Folder is not a Git checkout.'),
				],
				lifecycle: null,
				name: entry.name,
				outcome: 'skipped',
				pendingRename: false,
			});
			continue;
		}

		try {
			const output = execFileSync('git', ['-C', repoPath, 'log', '-1', '--format=%cI'], {
				stdio: ['pipe', 'pipe', 'ignore'],
			});
			const iso = output.toString().trim();
			if (!iso) throw new Error('No commit found');

			const commitTime = new Date(iso);
			if (Number.isNaN(commitTime.getTime())) throw new Error('Invalid commit date');

			if (!options.dryRun) fs.utimesSync(repoPath, commitTime, commitTime);
			displayRows.push({
				name: entry.name,
				newTime: commitTime,
				oldTime,
				status: options.dryRun ? 'would-update' : 'updated',
			});
			checkouts.push({
				findings: options.dryRun
					? [
							createFinding(
								'info',
								'date-update-planned',
								'Folder timestamp would be updated.'
							),
						]
					: [],
				lifecycle: 'active',
				name: entry.name,
				outcome: options.dryRun ? 'skipped' : 'updated',
				pendingRename: false,
				...(options.dryRun ? { plannedOutcome: 'updated' as const } : {}),
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			displayRows.push({
				name: entry.name,
				newTime: oldTime,
				oldTime,
				status: 'skipped:no-commit',
			});
			checkouts.push(
				failedCheckout(
					entry.name,
					'active',
					'date-read-failed',
					`Cannot read the latest commit date: ${message}`
				)
			);
		}
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
