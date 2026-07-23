import type { ArchiveInspection } from './archive-migration.ts';
import type { VerifiedCheckout } from './archive-verification-checkout.ts';
import type { CheckoutReport, Finding } from './reporting.ts';

import { inspectArchive } from './archive-migration.ts';
import { verifyCheckout } from './archive-verification-checkout.ts';
import { applyDuplicateIdentityFindings } from './archive-verification-duplicates.ts';
import {
	createInspectionFailureResult,
	finalizeVerificationResult,
	validateArchiveOwner,
} from './archive-verification-reporting.ts';

const VERIFICATION_CONCURRENCY = 4;

export interface ArchiveVerificationOptions {
	isInterruptionRequested?: () => boolean;
	onProgress?: (message: string) => void;
}

export interface ArchiveVerificationResult {
	checkouts: CheckoutReport[];
	exitCode: 0 | 1 | 130;
	findings: Finding[];
	interrupted: boolean;
}

const inspectForVerification = (
	targetPath: string
): ArchiveInspection | ArchiveVerificationResult => {
	try {
		return inspectArchive(targetPath);
	} catch (err) {
		return createInspectionFailureResult(err);
	}
};

const verifyEntries = async (
	inspection: ArchiveInspection,
	options: ArchiveVerificationOptions
): Promise<(undefined | VerifiedCheckout)[]> => {
	const results: (undefined | VerifiedCheckout)[] = new Array(inspection.entries.length);
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		while (!(options.isInterruptionRequested?.() ?? false)) {
			const index = nextIndex++;
			if (index >= inspection.entries.length) return;
			const entry = inspection.entries[index]!;
			options.onProgress?.(
				`Verifying ${index + 1}/${inspection.entries.length} — ${entry.name}`
			);
			results[index] = await verifyCheckout(entry, inspection.kind);
		}
	};
	const count = Math.min(VERIFICATION_CONCURRENCY, inspection.entries.length);
	await Promise.all(Array.from({ length: count }, () => worker()));
	return results;
};

export const verifyArchive = async (
	targetPath: string,
	options: ArchiveVerificationOptions = {}
): Promise<ArchiveVerificationResult> => {
	const inspection = inspectForVerification(targetPath);
	if (!('kind' in inspection)) return inspection;
	const findings = [...inspection.findings, ...validateArchiveOwner(targetPath, inspection)];
	if (['invalid', 'newer-managed', 'uninitialized'].includes(inspection.kind)) {
		return { checkouts: [], exitCode: 1, findings, interrupted: false };
	}
	const results = await verifyEntries(inspection, options);
	const verified = results.filter((result): result is VerifiedCheckout => result !== undefined);
	applyDuplicateIdentityFindings(verified);
	return finalizeVerificationResult(inspection, findings, results, verified);
};
