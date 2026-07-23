import fs from 'node:fs';
import path from 'node:path';

import type { RepoRecord } from './refresh.ts';
import type { CheckoutReport } from './reporting.ts';

import { parseGitHubRepositorySlug } from './archive-migration.ts';
import { canonicalCheckoutName, readCheckoutIdentity } from './checkout-identity.ts';
import { runGit } from './git-exec.ts';
import { createFinding } from './reporting.ts';
import {
	hasEmbeddedCredentials,
	isGitHubDotComUrl,
	sanitizeMessage,
	sanitizeUrl,
} from './secret-safety.ts';

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

const blockedReport = (name: string, code: string, message: string): CheckoutReport => ({
	findings: [createFinding('error', code, message)],
	lifecycle: 'blocked',
	name,
	outcome: 'failed',
	pendingRename: false,
});

export const scanManagedCheckouts = async (
	targetPath: string
): Promise<{ checkouts: ManagedCheckout[]; reports: CheckoutReport[] }> => {
	const checkouts: ManagedCheckout[] = [];
	const reports: CheckoutReport[] = [];
	const entries = fs
		.readdirSync(targetPath, { withFileTypes: true })
		.filter((entry) => entry.name !== '.starsync' && entry.isDirectory())
		.sort((left, right) => left.name.localeCompare(right.name));

	for (const entry of entries) {
		const checkoutPath = path.join(targetPath, entry.name);
		if (!fs.existsSync(path.join(checkoutPath, '.git'))) continue;
		try {
			const identity = await readCheckoutIdentity(checkoutPath);
			if (identity === null) {
				reports.push(
					blockedReport(
						entry.name,
						'missing-identity-metadata',
						'Managed checkout has no stable repository identity; run migrate --apply.'
					)
				);
				continue;
			}
			const origin = await runGit(['config', '--local', '--get', 'remote.origin.url'], {
				cwd: checkoutPath,
			});
			const originSlug = parseGitHubRepositorySlug(origin);
			if (
				hasEmbeddedCredentials(origin) ||
				!isGitHubDotComUrl(origin) ||
				originSlug === null ||
				`${originSlug.owner}/${originSlug.repository}`.toLowerCase() !==
					identity.repositorySlug.toLowerCase()
			) {
				reports.push(
					blockedReport(
						entry.name,
						'identity-origin-mismatch',
						`Managed checkout identity does not match origin ${sanitizeUrl(origin)}.`
					)
				);
				continue;
			}
			checkouts.push({ name: entry.name, ...identity });
		} catch (err) {
			reports.push(
				blockedReport(
					entry.name,
					'invalid-identity-metadata',
					`Cannot read managed checkout identity: ${sanitizeMessage(
						err instanceof Error ? err.message : String(err)
					)}`
				)
			);
		}
	}

	const counts = new Map<number, number>();
	for (const checkout of checkouts) {
		counts.set(checkout.repositoryId, (counts.get(checkout.repositoryId) ?? 0) + 1);
	}
	const unique = checkouts.filter((checkout) => {
		if ((counts.get(checkout.repositoryId) ?? 0) === 1) return true;
		reports.push(
			blockedReport(
				checkout.name,
				'duplicate-identity',
				`Repository identity ${checkout.repositoryId} is used by more than one checkout.`
			)
		);
		return false;
	});
	return { checkouts: unique, reports };
};

const retainedReport = (checkout: ManagedCheckout): CheckoutReport => {
	const canonicalName = canonicalCheckoutName(checkout.repositorySlug);
	return {
		findings: [
			createFinding(
				'info',
				'checkout-retained',
				'Checkout is no longer starred and was retained.'
			),
		],
		lifecycle: 'retained',
		name: checkout.name,
		outcome: 'skipped',
		pendingRename: canonicalName !== null && canonicalName !== checkout.name,
	};
};

export const planManagedSync = async (
	targetPath: string,
	repositories: StarredRepositoryRecord[]
): Promise<ManagedSyncPlan> => {
	const scan = await scanManagedCheckouts(targetPath);
	const existingById = new Map(
		scan.checkouts.map((checkout) => [checkout.repositoryId, checkout])
	);
	const existingNames = new Set(
		fs
			.readdirSync(targetPath, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name !== '.starsync')
			.map((entry) => entry.name.toLowerCase())
	);
	const starredIds = new Set(repositories.map((repository) => repository.id));
	const retainedReports = scan.checkouts
		.filter((checkout) => !starredIds.has(checkout.repositoryId))
		.map(retainedReport);
	const blockedReports = [...scan.reports];
	const planned: StarredRepository[] = [];

	const idCounts = new Map<number, number>();
	const nameCounts = new Map<string, number>();
	for (const repository of repositories) {
		if (!Number.isSafeInteger(repository.id) || repository.id <= 0) continue;
		idCounts.set(repository.id, (idCounts.get(repository.id) ?? 0) + 1);
		const canonicalName = canonicalCheckoutName(repository.slug);
		if (canonicalName === null) continue;
		const nameKey = canonicalName.toLowerCase();
		nameCounts.set(nameKey, (nameCounts.get(nameKey) ?? 0) + 1);
	}

	for (const repository of repositories) {
		const existing = existingById.get(repository.id);
		const canonicalName = canonicalCheckoutName(repository.slug);
		if (!Number.isSafeInteger(repository.id) || repository.id <= 0 || canonicalName === null) {
			blockedReports.push(
				blockedReport(
					repository.name,
					'invalid-repository-identity',
					'Repository response must contain a positive stable ID and valid owner/repository slug.'
				)
			);
			continue;
		}
		const duplicateIdentity = (idCounts.get(repository.id) ?? 0) > 1;
		const duplicateDestination = (nameCounts.get(canonicalName.toLowerCase()) ?? 0) > 1;
		if (duplicateIdentity || duplicateDestination) {
			blockedReports.push(
				blockedReport(
					existing?.name ?? canonicalName,
					duplicateIdentity ? 'duplicate-identity' : 'migration-name-collision',
					duplicateIdentity
						? `Repository identity ${repository.id} appears more than once in the starred repository response.`
						: `Canonical folder ${canonicalName} is requested by more than one repository.`
				)
			);
			continue;
		}
		if (existing === undefined && existingNames.has(canonicalName.toLowerCase())) {
			blockedReports.push(
				blockedReport(
					canonicalName,
					'checkout-name-collision',
					`Canonical folder ${canonicalName} is occupied by a different or unidentified archive entry.`
				)
			);
			continue;
		}
		const folderName = existing?.name ?? canonicalName;
		planned.push({
			...repository,
			folderName,
			pendingRename: existing !== undefined && folderName !== canonicalName,
		});
	}

	return { blockedReports, repositories: planned, retainedReports };
};
