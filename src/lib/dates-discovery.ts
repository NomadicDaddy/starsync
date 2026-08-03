import fs from 'node:fs';
import path from 'node:path';

import type { DatesDisplayRow } from './dates-reporting.ts';
import type { ManagedCheckout } from './managed-checkout-planning.ts';
import type { CheckoutReport, Finding } from './reporting.ts';

import { ARCHIVE_CONFIG_DIRECTORY } from './archive-config.ts';
import { createDateFailure } from './dates-reporting.ts';
import { scanManagedCheckouts } from './managed-checkout-planning.ts';
import { createFinding } from './reporting.ts';

export interface DatesDiscoveryResult {
	checkouts: CheckoutReport[];
	displayRows: DatesDisplayRow[];
	fatalFinding: Finding | null;
	managedCheckouts: ManagedCheckout[];
}

const discoverNonGitEntry = (
	target: string,
	entry: fs.Dirent,
): { report: CheckoutReport; row: DatesDisplayRow | null } | null => {
	const checkoutPath = path.join(target, entry.name);
	if (fs.existsSync(path.join(checkoutPath, '.git'))) return null;
	try {
		const folderTime = fs.statSync(checkoutPath).mtime;
		return {
			report: {
				findings: [
					createFinding('info', 'not-git-checkout', 'Folder is not a Git checkout.'),
				],
				lifecycle: null,
				name: entry.name,
				outcome: 'skipped',
				pendingRename: false,
			},
			row: {
				name: entry.name,
				newTime: folderTime,
				oldTime: folderTime,
				status: 'skipped:not-git',
			},
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			report: createDateFailure(
				entry.name,
				null,
				'checkout-stat-failed',
				`Cannot stat ${checkoutPath}: ${message}`,
			),
			row: null,
		};
	}
};

const readNonGitEntries = (target: string): DatesDiscoveryResult => {
	const checkouts: CheckoutReport[] = [];
	const displayRows: DatesDisplayRow[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(target, { withFileTypes: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			checkouts,
			displayRows,
			fatalFinding: createFinding(
				'error',
				'target-read-failed',
				`Cannot read ${target}: ${message}`,
			),
			managedCheckouts: [],
		};
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === ARCHIVE_CONFIG_DIRECTORY) continue;
		const discovered = discoverNonGitEntry(target, entry);
		if (discovered === null) continue;
		checkouts.push(discovered.report);
		if (discovered.row !== null) displayRows.push(discovered.row);
	}
	return { checkouts, displayRows, fatalFinding: null, managedCheckouts: [] };
};

export const discoverDateCheckouts = async (target: string): Promise<DatesDiscoveryResult> => {
	const result = readNonGitEntries(target);
	if (result.fatalFinding !== null) return result;
	try {
		const managed = await scanManagedCheckouts(target);
		result.checkouts.push(...managed.reports);
		result.managedCheckouts = managed.checkouts;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		result.fatalFinding = createFinding(
			'error',
			'managed-checkout-scan-failed',
			`Cannot discover managed checkouts: ${message}`,
		);
	}
	return result;
};
