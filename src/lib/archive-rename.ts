import type { ArchiveEntry, ArchiveInspection } from './archive-inspection.ts';
import type { ResolvedRenameEntry } from './checkout-rename-resolution.ts';
import type { CheckoutReport, Finding, RenamePreview } from './reporting.ts';
import type { RepositoryResolver } from './repository-resolution.ts';

import { inspectArchive } from './archive-inspection.ts';
import { classifyResolvedRenames } from './checkout-rename-classification.ts';
import { resolveRenameEntry } from './checkout-rename-resolution.ts';
import { createFinding } from './reporting.ts';

const RENAME_PREVIEW_CONCURRENCY = 4;

export interface RenameResult {
	checkouts: CheckoutReport[];
	exitCode: 0 | 1 | 130;
	findings: Finding[];
	interrupted: boolean;
}

export interface RenameOptions {
	isInterruptionRequested?: () => boolean;
	onProgress?: (message: string) => void;
}

type EntryResult = CheckoutReport | ResolvedRenameEntry | undefined;

const invalidInspectionResult = (inspection: ArchiveInspection): RenameResult => ({
	checkouts: [],
	exitCode: 1,
	findings: inspection.findings,
	interrupted: false,
});

const resolveEntries = async (
	inspection: ArchiveInspection,
	resolver: RepositoryResolver,
	options: RenameOptions,
): Promise<EntryResult[]> => {
	const results: EntryResult[] = new Array(inspection.entries.length);
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		while (!(options.isInterruptionRequested?.() ?? false)) {
			const index = nextIndex++;
			if (index >= inspection.entries.length) return;
			const entry = inspection.entries[index]!;
			options.onProgress?.(
				`Inspecting ${index + 1}/${inspection.entries.length} — ${entry.name}`,
			);
			results[index] = await resolveRenameEntry(entry, resolver);
		}
	};
	const count = Math.min(RENAME_PREVIEW_CONCURRENCY, inspection.entries.length);
	await Promise.all(Array.from({ length: count }, () => worker()));
	return results;
};

const interruptedReport = (entry: ArchiveEntry): CheckoutReport => ({
	findings: [
		createFinding(
			'warning',
			'interrupted-before-inspection',
			'Checkout was not inspected because interruption was requested.',
		),
	],
	lifecycle: entry.isGitCheckout ? 'active' : null,
	name: entry.name,
	outcome: 'skipped',
	pendingRename: false,
});

const createRenameResult = (
	inspection: ArchiveInspection,
	results: EntryResult[],
): RenameResult => {
	const immediate = results.filter(
		(result): result is CheckoutReport => result !== undefined && !('preview' in result),
	);
	const resolved = results.filter(
		(result): result is ResolvedRenameEntry => result !== undefined && 'preview' in result,
	);
	const interrupted = inspection.entries.flatMap((entry, index) =>
		results[index] === undefined ? [interruptedReport(entry)] : [],
	);
	const checkouts = [
		...classifyResolvedRenames(resolved, inspection.entries),
		...immediate,
		...interrupted,
	].sort((left, right) => left.name.localeCompare(right.name));
	const wasInterrupted = interrupted.length > 0;
	const hasErrors = checkouts.some((checkout) =>
		checkout.findings.some((finding) => finding.severity === 'error'),
	);
	const findings = wasInterrupted
		? [
				...inspection.findings,
				createFinding(
					'warning',
					'interrupted',
					'Rename preview was interrupted; results are partial.',
				),
			]
		: inspection.findings;
	return {
		checkouts,
		exitCode: wasInterrupted ? 130 : hasErrors ? 1 : 0,
		findings,
		interrupted: wasInterrupted,
	};
};

export const previewArchiveRenames = async (
	targetPath: string,
	resolver: RepositoryResolver,
	options: RenameOptions = {},
	inspection: ArchiveInspection = inspectArchive(targetPath),
): Promise<RenameResult> => {
	if (inspection.kind !== 'current') return invalidInspectionResult(inspection);
	return createRenameResult(inspection, await resolveEntries(inspection, resolver, options));
};

export type { RenamePreview };
