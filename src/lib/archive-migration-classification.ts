import type { ResolvedEntry } from './archive-migration-resolution.ts';
import type { ArchiveEntry } from './archive-migration.ts';
import type { CheckoutReport, MigrationPreview } from './reporting.ts';

import { createFinding } from './reporting.ts';

interface CollisionCounts {
	identities: Map<number, number>;
	names: Map<string, number>;
}

const normalizeFolderName = (name: string): string => name.toLowerCase();

const countCollisions = (entries: ResolvedEntry[]): CollisionCounts => {
	const counts: CollisionCounts = { identities: new Map(), names: new Map() };
	for (const { preview } of entries) {
		if (preview.repositoryId !== null) {
			counts.identities.set(
				preview.repositoryId,
				(counts.identities.get(preview.repositoryId) ?? 0) + 1
			);
		}
		if (preview.proposedName !== null) {
			const key = normalizeFolderName(preview.proposedName);
			counts.names.set(key, (counts.names.get(key) ?? 0) + 1);
		}
	}
	return counts;
};

const collisionReport = (
	entry: ArchiveEntry,
	preview: MigrationPreview,
	duplicateIdentity: boolean
): CheckoutReport => ({
	findings: [
		createFinding(
			'error',
			duplicateIdentity ? 'duplicate-identity' : 'migration-name-collision',
			duplicateIdentity
				? `Repository identity ${preview.repositoryId} is resolved by more than one checkout.`
				: `Proposed folder ${preview.proposedName} collides with another archive entry.`
		),
	],
	lifecycle: 'blocked',
	migration: { ...preview, classification: 'failed' },
	name: entry.name,
	outcome: 'failed',
	pendingRename: preview.proposedName !== entry.name,
});

const blockedReport = (
	entry: ArchiveEntry,
	preview: MigrationPreview,
	blockedReason: string
): CheckoutReport => ({
	findings: [createFinding('error', 'adopted-but-blocked', blockedReason)],
	lifecycle: 'blocked',
	migration: { ...preview, classification: 'adopted-but-blocked' },
	name: entry.name,
	outcome: 'skipped',
	pendingRename: preview.proposedName !== entry.name,
	plannedOutcome: 'updated',
});

const migratableReport = (entry: ArchiveEntry, preview: MigrationPreview): CheckoutReport => {
	const pendingRename = preview.proposedName !== entry.name;
	return {
		findings: [
			pendingRename
				? createFinding(
						'warning',
						'pending-rename',
						`Checkout would be renamed to ${preview.proposedName}.`
					)
				: createFinding(
						'info',
						'safely-migratable',
						`Checkout identity ${preview.repositoryId} can be recorded without a folder rename.`
					),
		],
		lifecycle: 'active',
		migration: {
			...preview,
			classification: pendingRename ? 'pending-rename' : 'safely-migratable',
		},
		name: entry.name,
		outcome: 'skipped',
		pendingRename,
		plannedOutcome: 'updated',
	};
};

const classifyResolvedEntry = (
	resolved: ResolvedEntry,
	counts: CollisionCounts,
	allEntryNames: Set<string>
): CheckoutReport => {
	const { blockedReason, entry, preview } = resolved;
	const repositoryId = preview.repositoryId!;
	const proposedName = preview.proposedName!;
	const proposedKey = normalizeFolderName(proposedName);
	const duplicateIdentity = (counts.identities.get(repositoryId) ?? 0) > 1;
	const duplicateDestination = (counts.names.get(proposedKey) ?? 0) > 1;
	const occupied =
		proposedKey !== normalizeFolderName(entry.name) && allEntryNames.has(proposedKey);
	if (duplicateIdentity || duplicateDestination || occupied) {
		return collisionReport(entry, preview, duplicateIdentity);
	}
	return blockedReason
		? blockedReport(entry, preview, blockedReason)
		: migratableReport(entry, preview);
};

export const classifyResolvedEntries = (
	resolvedEntries: ResolvedEntry[],
	allEntries: ArchiveEntry[]
): CheckoutReport[] => {
	const counts = countCollisions(resolvedEntries);
	const names = new Set(allEntries.map((entry) => normalizeFolderName(entry.name)));
	return resolvedEntries.map((resolved) => classifyResolvedEntry(resolved, counts, names));
};
