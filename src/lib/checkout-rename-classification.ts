import type { ArchiveEntry } from './archive-inspection.ts';
import type { ResolvedRenameEntry } from './checkout-rename-resolution.ts';
import type { CheckoutReport, RenamePreview } from './reporting.ts';

import { createFinding } from './reporting.ts';

interface CollisionCounts {
	identities: Map<number, number>;
	names: Map<string, number>;
}

const normalizeFolderName = (name: string): string => name.toLowerCase();

const countCollisions = (entries: ResolvedRenameEntry[]): CollisionCounts => {
	const counts: CollisionCounts = { identities: new Map(), names: new Map() };
	for (const { preview } of entries) {
		const repositoryId = preview.repositoryId!;
		const proposedName = normalizeFolderName(preview.proposedName!);
		counts.identities.set(repositoryId, (counts.identities.get(repositoryId) ?? 0) + 1);
		counts.names.set(proposedName, (counts.names.get(proposedName) ?? 0) + 1);
	}
	return counts;
};

const collisionReport = (
	entry: ArchiveEntry,
	preview: RenamePreview,
	duplicateIdentity: boolean
): CheckoutReport => ({
	findings: [
		createFinding(
			'error',
			duplicateIdentity ? 'duplicate-identity' : 'rename-name-collision',
			duplicateIdentity
				? `Repository identity ${preview.repositoryId} is resolved by more than one checkout.`
				: `Proposed folder ${preview.proposedName} collides with another archive entry.`
		),
	],
	lifecycle: 'blocked',
	name: entry.name,
	outcome: 'failed',
	pendingRename: preview.proposedName !== entry.name,
	rename: { ...preview, classification: 'failed' },
});

const blockedReport = (
	entry: ArchiveEntry,
	preview: RenamePreview,
	blockedReason: string
): CheckoutReport => ({
	findings: [createFinding('error', 'rename-blocked', blockedReason)],
	lifecycle: 'blocked',
	name: entry.name,
	outcome: 'skipped',
	pendingRename: preview.proposedName !== entry.name,
	plannedOutcome: 'updated',
	rename: { ...preview, classification: 'blocked' },
});

const readyReport = (resolved: ResolvedRenameEntry): CheckoutReport => {
	const { entry, preview } = resolved;
	const pending = preview.classification === 'pending';
	return {
		findings: [
			pending
				? createFinding(
						'warning',
						'rename-pending',
						`Checkout would become ${preview.proposedName}.`
					)
				: createFinding(
						'info',
						'rename-current',
						'Checkout identity, origin, and folder are current.'
					),
		],
		lifecycle: 'active',
		name: entry.name,
		outcome: pending ? 'skipped' : 'current',
		pendingRename: preview.proposedName !== entry.name,
		...(pending ? { plannedOutcome: 'updated' as const } : {}),
		rename: preview,
	};
};

const classifyEntry = (
	resolved: ResolvedRenameEntry,
	counts: CollisionCounts,
	allEntryNames: Set<string>
): CheckoutReport => {
	const { blockedReason, entry, preview } = resolved;
	const repositoryId = preview.repositoryId!;
	const proposedKey = normalizeFolderName(preview.proposedName!);
	const duplicateIdentity = (counts.identities.get(repositoryId) ?? 0) > 1;
	const duplicateDestination = (counts.names.get(proposedKey) ?? 0) > 1;
	const occupied =
		proposedKey !== normalizeFolderName(entry.name) && allEntryNames.has(proposedKey);
	if (duplicateIdentity || duplicateDestination || occupied) {
		return collisionReport(entry, preview, duplicateIdentity);
	}
	return blockedReason ? blockedReport(entry, preview, blockedReason) : readyReport(resolved);
};

export const classifyResolvedRenames = (
	resolvedEntries: ResolvedRenameEntry[],
	allEntries: ArchiveEntry[]
): CheckoutReport[] => {
	const counts = countCollisions(resolvedEntries);
	const names = new Set(allEntries.map((entry) => normalizeFolderName(entry.name)));
	return resolvedEntries.map((resolved) => classifyEntry(resolved, counts, names));
};
