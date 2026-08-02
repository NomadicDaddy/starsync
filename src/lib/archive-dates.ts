import fs from 'node:fs';

import { runGit } from './git-exec.ts';

const DATE_ALIGNMENT_TOLERANCE_MS = 1_000;

export interface ArchiveDateState {
	archiveDate: Date;
	currentDate: Date;
	needsUpdate: boolean;
}

const readArchiveDate = async (checkoutPath: string): Promise<Date> => {
	const output = await runGit(['log', '--all', '--format=%cI'], { cwd: checkoutPath });
	const timestamps = output.split(/\r?\n/).filter(Boolean);
	if (timestamps.length === 0) {
		throw new Error('Checkout has no commit reachable from any local Git reference.');
	}

	let newestTimestamp = Number.NEGATIVE_INFINITY;
	for (const timestamp of timestamps) {
		const parsed = Date.parse(timestamp);
		if (Number.isNaN(parsed)) {
			throw new Error(`Git returned an invalid committer timestamp: ${timestamp}`);
		}
		newestTimestamp = Math.max(newestTimestamp, parsed);
	}
	return new Date(newestTimestamp);
};

export const inspectArchiveDate = async (checkoutPath: string): Promise<ArchiveDateState> => {
	const currentDate = fs.statSync(checkoutPath).mtime;
	const archiveDate = await readArchiveDate(checkoutPath);
	return {
		archiveDate,
		currentDate,
		needsUpdate:
			Math.abs(currentDate.getTime() - archiveDate.getTime()) >= DATE_ALIGNMENT_TOLERANCE_MS,
	};
};

export const setCheckoutArchiveDate = (checkoutPath: string, archiveDate: Date): void => {
	fs.utimesSync(checkoutPath, archiveDate, archiveDate);
};
