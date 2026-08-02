import type { ArchiveInspection } from './archive-inspection.ts';
import type { VerifiedCheckout } from './archive-verification-checkout.ts';
import type { CheckoutReport, Finding } from './reporting.ts';

import { inspectArchive } from './archive-inspection.ts';
import { verifyCheckout } from './archive-verification-checkout.ts';
import { applyDuplicateIdentityFindings } from './archive-verification-duplicates.ts';
import {
	repairAnomalousCheckout,
	type ArchiveVerificationRepairOptions,
} from './archive-verification-repair.ts';
import {
	createInspectionFailureResult,
	finalizeVerificationResult,
	validateArchiveOwner,
} from './archive-verification-reporting.ts';
import { createFinding } from './reporting.ts';

const VERIFICATION_CONCURRENCY = 4;

export interface ArchiveVerificationOptions {
	isInterruptionRequested?: () => boolean;
	onProgress?: (message: string) => void;
	repair?: ArchiveVerificationRepairOptions;
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

const verifyEntry = async (
	entry: ArchiveInspection['entries'][number],
	inspection: ArchiveInspection,
	index: number,
	options: ArchiveVerificationOptions
): Promise<VerifiedCheckout> => {
	const verified = await verifyCheckout(entry);
	const replaceable = verified.report.findings.some(
		(finding) =>
			finding.code === 'git-integrity-failed' ||
			finding.code === 'checkout-blocked' ||
			finding.code === 'missing-identity-metadata'
	);
	if (options.repair === undefined || !replaceable) return verified;
	options.onProgress?.(
		`Recloning anomalous checkout ${index + 1}/${inspection.entries.length} — ${entry.name}`
	);
	const repaired = await repairAnomalousCheckout(entry, verified, options.repair);
	if (!repaired.ok) {
		verified.report.findings.push(
			createFinding('error', 'checkout-reclone-failed', repaired.reason)
		);
		return verified;
	}
	const replacement = await verifyCheckout({
		...entry,
		gitError: null,
		origin: `https://github.com/${repaired.repository.slug}.git`,
	});
	replacement.report.findings.unshift(
		createFinding(
			'info',
			'checkout-recloned',
			`Anomalous checkout was replaced from ${repaired.repository.slug}.`
		)
	);
	if (repaired.cleanupWarning !== null) {
		replacement.report.findings.push(
			createFinding('warning', 'damaged-checkout-cleanup-failed', repaired.cleanupWarning)
		);
	}
	if (replacement.report.lifecycle === 'active') replacement.report.outcome = 'updated';
	return replacement;
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
			results[index] = await verifyEntry(entry, inspection, index, options);
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
	if (inspection.kind !== 'current') {
		return { checkouts: [], exitCode: 1, findings, interrupted: false };
	}
	const results = await verifyEntries(inspection, options);
	const verified = results.filter((result): result is VerifiedCheckout => result !== undefined);
	applyDuplicateIdentityFindings(verified);
	return finalizeVerificationResult(inspection, findings, results, verified);
};
