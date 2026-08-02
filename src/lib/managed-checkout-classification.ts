import type {
	ManagedCheckout,
	StarredRepository,
	StarredRepositoryRecord,
} from './managed-checkout-planning.ts';
import type { CheckoutReport } from './reporting.ts';

import { canonicalCheckoutName } from './checkout-identity.ts';
import { createFinding } from './reporting.ts';

export interface StarredRepositoryCollisionIndexes {
	idCounts: Map<number, number>;
	nameCounts: Map<string, number>;
}

export interface StarredRepositoryClassificationContext {
	collisions: StarredRepositoryCollisionIndexes;
	existingById: Map<number, ManagedCheckout>;
	existingNames: Set<string>;
}

export interface StarredRepositoryClassification {
	report: CheckoutReport | null;
	repository: null | StarredRepository;
}

export const blockedCheckoutReport = (
	name: string,
	code: string,
	message: string
): CheckoutReport => ({
	findings: [createFinding('error', code, message)],
	lifecycle: 'blocked',
	name,
	outcome: 'failed',
	pendingRename: false,
});

const isValidRepositoryId = (repositoryId: number): boolean =>
	Number.isSafeInteger(repositoryId) && repositoryId > 0;

const canonicalRepositoryName = (repository: StarredRepositoryRecord): null | string => {
	if (!isValidRepositoryId(repository.id)) return null;
	return canonicalCheckoutName(repository.slug);
};

export const buildStarredRepositoryCollisionIndexes = (
	repositories: StarredRepositoryRecord[]
): StarredRepositoryCollisionIndexes => {
	const idCounts = new Map<number, number>();
	const nameCounts = new Map<string, number>();
	for (const repository of repositories) {
		if (!isValidRepositoryId(repository.id)) continue;
		idCounts.set(repository.id, (idCounts.get(repository.id) ?? 0) + 1);
		const canonicalName = canonicalRepositoryName(repository);
		if (canonicalName === null) continue;
		const nameKey = canonicalName.toLowerCase();
		nameCounts.set(nameKey, (nameCounts.get(nameKey) ?? 0) + 1);
	}
	return { idCounts, nameCounts };
};

const invalidRepositoryReport = (repository: StarredRepositoryRecord): CheckoutReport =>
	blockedCheckoutReport(
		repository.name,
		'invalid-repository-identity',
		'Repository response must contain a positive stable ID and valid owner/repository slug.'
	);

const duplicateIdentityReport = (
	repository: StarredRepositoryRecord,
	existing: ManagedCheckout | undefined,
	canonicalName: string
): CheckoutReport =>
	blockedCheckoutReport(
		existing?.name ?? canonicalName,
		'duplicate-identity',
		`Repository identity ${repository.id} appears more than once in the starred repository response.`
	);

const duplicateDestinationReport = (canonicalName: string): CheckoutReport =>
	blockedCheckoutReport(
		canonicalName,
		'rename-name-collision',
		`Canonical folder ${canonicalName} is requested by more than one repository.`
	);

const occupiedDestinationReport = (canonicalName: string): CheckoutReport =>
	blockedCheckoutReport(
		canonicalName,
		'checkout-name-collision',
		`Canonical folder ${canonicalName} is occupied by a different or unidentified archive entry.`
	);

export const classifyStarredRepository = (
	repository: StarredRepositoryRecord,
	context: StarredRepositoryClassificationContext
): StarredRepositoryClassification => {
	const canonicalName = canonicalRepositoryName(repository);
	if (canonicalName === null)
		return { report: invalidRepositoryReport(repository), repository: null };
	const existing = context.existingById.get(repository.id);
	if ((context.collisions.idCounts.get(repository.id) ?? 0) > 1) {
		return {
			report: duplicateIdentityReport(repository, existing, canonicalName),
			repository: null,
		};
	}
	if ((context.collisions.nameCounts.get(canonicalName.toLowerCase()) ?? 0) > 1) {
		return { report: duplicateDestinationReport(canonicalName), repository: null };
	}
	if (existing === undefined && context.existingNames.has(canonicalName.toLowerCase())) {
		return { report: occupiedDestinationReport(canonicalName), repository: null };
	}
	const folderName = existing?.name ?? canonicalName;
	return {
		report: null,
		repository: {
			...repository,
			folderName,
			pendingRename: existing !== undefined && folderName !== canonicalName,
		},
	};
};

export const retainedCheckoutReport = (checkout: ManagedCheckout): CheckoutReport => {
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
