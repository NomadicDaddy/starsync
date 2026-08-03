import fs from 'node:fs';
import path from 'node:path';

import type { ManagedCheckout } from './managed-checkout-planning.ts';
import type { CheckoutReport } from './reporting.ts';

import { readCheckoutIdentity } from './checkout-identity.ts';
import { runGit } from './git-exec.ts';
import { blockedCheckoutReport } from './managed-checkout-classification.ts';
import { parseGitHubRepositorySlug } from './repository-resolution.ts';
import {
	hasEmbeddedCredentials,
	isGitHubDotComUrl,
	sanitizeMessage,
	sanitizeUrl,
} from './secret-safety.ts';

export interface ManagedCheckoutInspection {
	checkout: ManagedCheckout | null;
	report: CheckoutReport | null;
}

export interface ManagedCheckoutScan {
	checkouts: ManagedCheckout[];
	reports: CheckoutReport[];
}

const emptyInspection = (): ManagedCheckoutInspection => ({ checkout: null, report: null });

const originMatchesIdentity = (origin: string, repositorySlug: string): boolean => {
	if (hasEmbeddedCredentials(origin)) return false;
	if (!isGitHubDotComUrl(origin)) return false;
	const originSlug = parseGitHubRepositorySlug(origin);
	if (originSlug === null) return false;
	return (
		`${originSlug.owner}/${originSlug.repository}`.toLowerCase() ===
		repositorySlug.toLowerCase()
	);
};

const inspectGitCheckout = async (
	checkoutPath: string,
	name: string,
): Promise<ManagedCheckoutInspection> => {
	const identity = await readCheckoutIdentity(checkoutPath);
	if (identity === null) {
		return {
			checkout: null,
			report: blockedCheckoutReport(
				name,
				'missing-identity-metadata',
				'Format-2 managed checkout has no stable repository identity. A canonical checkout can be safely rebuilt with verify --force.',
			),
		};
	}
	const origin = await runGit(['config', '--local', '--get', 'remote.origin.url'], {
		cwd: checkoutPath,
	});
	if (!originMatchesIdentity(origin, identity.repositorySlug)) {
		return {
			checkout: null,
			report: blockedCheckoutReport(
				name,
				'identity-origin-mismatch',
				`Managed checkout identity does not match origin ${sanitizeUrl(origin)}.`,
			),
		};
	}
	return { checkout: { name, ...identity }, report: null };
};

export const inspectManagedCheckoutEntry = async (
	targetPath: string,
	name: string,
): Promise<ManagedCheckoutInspection> => {
	const checkoutPath = path.join(targetPath, name);
	if (!fs.existsSync(path.join(checkoutPath, '.git'))) return emptyInspection();
	try {
		return await inspectGitCheckout(checkoutPath, name);
	} catch (err) {
		return {
			checkout: null,
			report: blockedCheckoutReport(
				name,
				'invalid-identity-metadata',
				`Cannot read managed checkout identity: ${sanitizeMessage(
					err instanceof Error ? err.message : String(err),
				)}`,
			),
		};
	}
};

export const filterDuplicateCheckoutIdentities = (
	checkouts: ManagedCheckout[],
): ManagedCheckoutScan => {
	const counts = new Map<number, number>();
	for (const checkout of checkouts) {
		counts.set(checkout.repositoryId, (counts.get(checkout.repositoryId) ?? 0) + 1);
	}
	const unique: ManagedCheckout[] = [];
	const reports: CheckoutReport[] = [];
	for (const checkout of checkouts) {
		if ((counts.get(checkout.repositoryId) ?? 0) === 1) {
			unique.push(checkout);
			continue;
		}
		reports.push(
			blockedCheckoutReport(
				checkout.name,
				'duplicate-identity',
				`Repository identity ${checkout.repositoryId} is used by more than one checkout.`,
			),
		);
	}
	return { checkouts: unique, reports };
};
