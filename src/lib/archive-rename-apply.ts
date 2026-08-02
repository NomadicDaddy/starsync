import type { RenameOptions, RenameResult } from './archive-rename.ts';
import type { CheckoutReport, Finding } from './reporting.ts';
import type { RepositoryResolver } from './repository-resolution.ts';

import { inspectArchive } from './archive-inspection.ts';
import { previewArchiveRenames } from './archive-rename.ts';
import { applyCheckoutRename } from './checkout-rename-apply.ts';
import { createFinding } from './reporting.ts';

interface AppliedPreview {
	complete: boolean;
	interrupted: boolean;
	reports: CheckoutReport[];
}

const interruptedReports = (remaining: CheckoutReport[]): CheckoutReport[] =>
	remaining.map((checkout) => ({
		...checkout,
		findings: [
			createFinding(
				'warning',
				'interrupted-before-apply',
				'Checkout rename was not applied because interruption was requested.'
			),
		],
		outcome: 'skipped',
	}));

const applyPreview = async (
	targetPath: string,
	preview: RenameResult,
	entries: ReturnType<typeof inspectArchive>['entries'],
	options: RenameOptions
): Promise<AppliedPreview> => {
	const reports: CheckoutReport[] = [];
	let complete = true;
	for (const [index, checkout] of preview.checkouts.entries()) {
		if (options.isInterruptionRequested?.()) {
			reports.push(...interruptedReports(preview.checkouts.slice(index)));
			return { complete: false, interrupted: true, reports };
		}
		options.onProgress?.(
			`Applying ${index + 1}/${preview.checkouts.length} — ${checkout.name}`
		);
		const applied = await applyCheckoutRename(targetPath, checkout, entries);
		reports.push(applied.report);
		complete &&= applied.applied;
	}
	return { complete, interrupted: false, reports };
};

const completionFinding = (applied: AppliedPreview): Finding => {
	if (applied.interrupted) {
		return createFinding(
			'warning',
			'interrupted',
			'Rename was interrupted; completed checkout updates were preserved.'
		);
	}
	return applied.complete
		? createFinding('info', 'rename-completed', 'Checkout rename operation completed.')
		: createFinding(
				'error',
				'rename-partial',
				'Rename is incomplete; successful checkout updates were preserved.'
			);
};

const createResult = (preview: RenameResult, applied: AppliedPreview): RenameResult => ({
	checkouts: applied.reports,
	exitCode: applied.interrupted ? 130 : applied.complete ? 0 : 1,
	findings: [...preview.findings, completionFinding(applied)],
	interrupted: applied.interrupted,
});

export const applyArchiveRenames = async (
	targetPath: string,
	resolver: RepositoryResolver,
	options: RenameOptions = {}
): Promise<RenameResult> => {
	const inspection = inspectArchive(targetPath);
	if (inspection.kind !== 'current') return previewArchiveRenames(targetPath, resolver, options);
	const preview = await previewArchiveRenames(targetPath, resolver, options);
	if (preview.interrupted) return preview;
	const applied = await applyPreview(targetPath, preview, inspection.entries, options);
	return createResult(preview, applied);
};
