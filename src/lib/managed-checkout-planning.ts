import fs from 'node:fs';

import type { RepoRecord } from './refresh.ts';
import type { CheckoutReport } from './reporting.ts';

import {
	buildStarredRepositoryCollisionIndexes,
	classifyStarredRepository,
	retainedCheckoutReport,
} from './managed-checkout-classification.ts';
import {
	filterDuplicateCheckoutIdentities,
	inspectManagedCheckoutEntry,
} from './managed-checkout-inspection.ts';

export interface StarredRepository extends RepoRecord {
	folderName: string;
	id: number;
	pendingRename: boolean;
	slug: string;
}

export type StarredRepositoryRecord = Omit<StarredRepository, 'folderName' | 'pendingRename'>;

export interface ManagedCheckout {
	name: string;
	repositoryId: number;
	repositorySlug: string;
}

export interface ManagedSyncPlan {
	blockedReports: CheckoutReport[];
	repositories: StarredRepository[];
	retainedReports: CheckoutReport[];
}

const archiveEntryNames = (targetPath: string): string[] =>
	fs
		.readdirSync(targetPath, { withFileTypes: true })
		.filter((entry) => entry.name !== '.starsync' && entry.isDirectory())
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right));

export const scanManagedCheckouts = async (
	targetPath: string
): Promise<{ checkouts: ManagedCheckout[]; reports: CheckoutReport[] }> => {
	const checkouts: ManagedCheckout[] = [];
	const reports: CheckoutReport[] = [];
	for (const name of archiveEntryNames(targetPath)) {
		const inspection = await inspectManagedCheckoutEntry(targetPath, name);
		if (inspection.checkout !== null) checkouts.push(inspection.checkout);
		if (inspection.report !== null) reports.push(inspection.report);
	}
	const unique = filterDuplicateCheckoutIdentities(checkouts);
	return { checkouts: unique.checkouts, reports: [...reports, ...unique.reports] };
};

const collectRetainedReports = (
	checkouts: ManagedCheckout[],
	starredIds: Set<number>
): CheckoutReport[] => {
	const reports: CheckoutReport[] = [];
	for (const checkout of checkouts) {
		if (!starredIds.has(checkout.repositoryId)) reports.push(retainedCheckoutReport(checkout));
	}
	return reports;
};

export const planManagedSync = async (
	targetPath: string,
	repositories: StarredRepositoryRecord[]
): Promise<ManagedSyncPlan> => {
	const scan = await scanManagedCheckouts(targetPath);
	const context = {
		collisions: buildStarredRepositoryCollisionIndexes(repositories),
		existingById: new Map(scan.checkouts.map((checkout) => [checkout.repositoryId, checkout])),
		existingNames: new Set(archiveEntryNames(targetPath).map((name) => name.toLowerCase())),
	};
	const blockedReports = [...scan.reports];
	const planned: StarredRepository[] = [];
	for (const repository of repositories) {
		const classification = classifyStarredRepository(repository, context);
		if (classification.report !== null) blockedReports.push(classification.report);
		if (classification.repository !== null) planned.push(classification.repository);
	}
	const starredIds = new Set(repositories.map((repository) => repository.id));
	return {
		blockedReports,
		repositories: planned,
		retainedReports: collectRetainedReports(scan.checkouts, starredIds),
	};
};
