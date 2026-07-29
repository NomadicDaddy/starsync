import type { ResolvedEntry } from './archive-migration-resolution.ts';
import type { CheckoutReport, Finding, MigrationPreview } from './reporting.ts';

import { classifyResolvedEntries } from './archive-migration-classification.ts';
import { getArchiveModificationFinding, inspectArchive } from './archive-migration-inspection.ts';
import {
	createGitHubRepositoryResolver,
	parseGitHubRepositorySlug,
	resolveMigrationEntry,
} from './archive-migration-resolution.ts';
import { createFinding } from './reporting.ts';

const MIGRATION_PREVIEW_CONCURRENCY = 4;

export type ArchiveKind =
	'current-managed' | 'invalid' | 'legacy' | 'newer-managed' | 'older-managed' | 'uninitialized';

export interface ArchiveEntry {
	gitError: null | string;
	isGitCheckout: boolean;
	name: string;
	origin: null | string;
	path: string;
}

export interface ArchiveInspection {
	archiveFormat: null | number;
	entries: ArchiveEntry[];
	findings: Finding[];
	kind: ArchiveKind;
}

export interface ResolvedRepository {
	id: number;
	name: string;
	owner: string;
	slug: string;
}

export type RepositoryResolver = (owner: string, repository: string) => Promise<ResolvedRepository>;

export interface MigrationPreviewResult {
	checkouts: CheckoutReport[];
	exitCode: 0 | 1 | 130;
	findings: Finding[];
	interrupted: boolean;
}

export interface MigrationPreviewOptions {
	isInterruptionRequested?: () => boolean;
	onProgress?: (message: string) => void;
}

type EntryResult = CheckoutReport | ResolvedEntry | undefined;

const invalidInspectionResult = (inspection: ArchiveInspection): MigrationPreviewResult => ({
	checkouts: [],
	exitCode: inspection.findings.some((finding) => finding.severity === 'error') ? 1 : 0,
	findings: inspection.findings,
	interrupted: false,
});

const resolveEntries = async (
	inspection: ArchiveInspection,
	resolveRepository: RepositoryResolver,
	options: MigrationPreviewOptions
): Promise<EntryResult[]> => {
	const results: EntryResult[] = new Array(inspection.entries.length);
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		while (!(options.isInterruptionRequested?.() ?? false)) {
			const index = nextIndex++;
			if (index >= inspection.entries.length) return;
			const entry = inspection.entries[index]!;
			options.onProgress?.(
				`Inspecting ${index + 1}/${inspection.entries.length} — ${entry.name}`
			);
			results[index] = await resolveMigrationEntry(entry, resolveRepository);
		}
	};
	const count = Math.min(MIGRATION_PREVIEW_CONCURRENCY, inspection.entries.length);
	await Promise.all(Array.from({ length: count }, () => worker()));
	return results;
};

const interruptedEntryReport = (entry: ArchiveEntry): CheckoutReport => ({
	findings: [
		createFinding(
			'warning',
			'interrupted-before-inspection',
			'Checkout was not inspected because interruption was requested.'
		),
	],
	lifecycle: entry.isGitCheckout ? 'active' : null,
	name: entry.name,
	outcome: 'skipped',
	pendingRename: false,
});

const createMigrationResult = (
	inspection: ArchiveInspection,
	results: EntryResult[]
): MigrationPreviewResult => {
	const immediate = results.filter(
		(result): result is CheckoutReport => result !== undefined && !('preview' in result)
	);
	const resolved = results.filter(
		(result): result is ResolvedEntry => result !== undefined && 'preview' in result
	);
	const interruptedReports = inspection.entries.flatMap((entry, index) =>
		results[index] === undefined ? [interruptedEntryReport(entry)] : []
	);
	const checkouts = [
		...classifyResolvedEntries(resolved, inspection.entries),
		...immediate,
		...interruptedReports,
	].sort((left, right) => left.name.localeCompare(right.name));
	const interrupted = interruptedReports.length > 0;
	const hasErrors = checkouts.some((checkout) =>
		checkout.findings.some((finding) => finding.severity === 'error')
	);
	const findings = interrupted
		? [
				...inspection.findings,
				createFinding(
					'warning',
					'interrupted',
					'Migration preview was interrupted; results are partial.'
				),
			]
		: inspection.findings;
	return { checkouts, exitCode: interrupted ? 130 : hasErrors ? 1 : 0, findings, interrupted };
};

export const previewArchiveMigration = async (
	targetPath: string,
	resolveRepository: RepositoryResolver,
	options: MigrationPreviewOptions = {}
): Promise<MigrationPreviewResult> => {
	const inspection = inspectArchive(targetPath);
	if (['invalid', 'newer-managed', 'uninitialized'].includes(inspection.kind)) {
		return invalidInspectionResult(inspection);
	}
	const results = await resolveEntries(inspection, resolveRepository, options);
	return createMigrationResult(inspection, results);
};

export {
	createGitHubRepositoryResolver,
	getArchiveModificationFinding,
	inspectArchive,
	parseGitHubRepositorySlug,
};
export type { MigrationPreview };
