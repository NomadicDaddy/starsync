import path from 'node:path';

import type { ArchiveInspection } from './archive-inspection.ts';
import type { VerifiedCheckout } from './archive-verification-checkout.ts';
import type { CheckoutReport, Finding } from './reporting.ts';

import { inspectArchive } from './archive-inspection.ts';
import { verifyCheckout } from './archive-verification-checkout.ts';
import { applyDuplicateIdentityFindings } from './archive-verification-duplicates.ts';
import {
	type ArchiveVerificationRepairOptions,
	repairAnomalousCheckout,
} from './archive-verification-repair.ts';
import {
	createInspectionFailureResult,
	finalizeVerificationResult,
	validateArchiveOwner,
} from './archive-verification-reporting.ts';
import { canonicalCheckoutName } from './checkout-identity.ts';
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
	targetPath: string,
): ArchiveInspection | ArchiveVerificationResult => {
	try {
		return inspectArchive(targetPath);
	} catch (err) {
		return createInspectionFailureResult(err);
	}
};

const repairEntry = async (
	entry: ArchiveInspection['entries'][number],
	inspection: ArchiveInspection,
	index: number,
	options: ArchiveVerificationOptions,
	claimedRepositoryIds: Set<number>,
	verified: VerifiedCheckout,
): Promise<VerifiedCheckout> => {
	const replaceable = verified.report.findings.some(
		(finding) =>
			finding.code === 'git-integrity-failed' ||
			finding.code === 'checkout-blocked' ||
			finding.code === 'missing-identity-metadata',
	);
	const duplicated = verified.report.findings.some(
		(finding) => finding.code === 'duplicate-identity',
	);
	if (options.repair === undefined || !replaceable || duplicated) return verified;
	options.onProgress?.(
		`Recloning anomalous checkout ${index + 1}/${inspection.entries.length} — ${entry.name}`,
	);
	const repaired = await repairAnomalousCheckout(
		entry,
		verified,
		options.repair,
		claimedRepositoryIds,
	);
	if (!repaired.ok) {
		verified.report.findings.push(
			createFinding('error', 'checkout-reclone-failed', repaired.reason),
		);
		return verified;
	}
	const replacementName = canonicalCheckoutName(repaired.repository.slug)!;
	const replacement = await verifyCheckout({
		...entry,
		gitError: null,
		name: replacementName,
		origin: `https://github.com/${repaired.repository.slug}.git`,
		path: path.join(options.repair.targetPath, replacementName),
	});
	replacement.report.findings.unshift(
		createFinding(
			'info',
			'checkout-recloned',
			`Anomalous checkout was replaced from ${repaired.repository.slug}.`,
		),
	);
	if (repaired.cleanupWarning !== null) {
		replacement.report.findings.push(
			createFinding('warning', 'damaged-checkout-cleanup-failed', repaired.cleanupWarning),
		);
	}
	if (replacement.report.lifecycle === 'active') replacement.report.outcome = 'updated';
	return replacement;
};

const verifyEntries = async (
	inspection: ArchiveInspection,
	options: ArchiveVerificationOptions,
): Promise<(undefined | VerifiedCheckout)[]> => {
	const results: (undefined | VerifiedCheckout)[] = new Array(inspection.entries.length);
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		while (!(options.isInterruptionRequested?.() ?? false)) {
			const index = nextIndex++;
			if (index >= inspection.entries.length) return;
			const entry = inspection.entries[index]!;
			options.onProgress?.(
				`Verifying ${index + 1}/${inspection.entries.length} — ${entry.name}`,
			);
			results[index] = await verifyCheckout(entry);
		}
	};
	const count = Math.min(VERIFICATION_CONCURRENCY, inspection.entries.length);
	await Promise.all(Array.from({ length: count }, () => worker()));
	return results;
};

const repairEntries = async (
	inspection: ArchiveInspection,
	options: ArchiveVerificationOptions,
	results: (undefined | VerifiedCheckout)[],
): Promise<void> => {
	const claimedRepositoryIds = new Set(
		results.flatMap((result) =>
			result === undefined || result.repositoryId === null ? [] : [result.repositoryId],
		),
	);
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		while (!(options.isInterruptionRequested?.() ?? false)) {
			const index = nextIndex++;
			if (index >= inspection.entries.length) return;
			const verified = results[index];
			if (verified === undefined) continue;
			results[index] = await repairEntry(
				inspection.entries[index]!,
				inspection,
				index,
				options,
				claimedRepositoryIds,
				verified,
			);
		}
	};
	const count = Math.min(VERIFICATION_CONCURRENCY, inspection.entries.length);
	await Promise.all(Array.from({ length: count }, () => worker()));
};

export const verifyArchive = async (
	targetPath: string,
	options: ArchiveVerificationOptions = {},
): Promise<ArchiveVerificationResult> => {
	const inspection = inspectForVerification(targetPath);
	if (!('kind' in inspection)) return inspection;
	const findings = [...inspection.findings, ...validateArchiveOwner(targetPath, inspection)];
	if (inspection.kind !== 'current') {
		return { checkouts: [], exitCode: 1, findings, interrupted: false };
	}
	const results = await verifyEntries(inspection, options);
	applyDuplicateIdentityFindings(
		results.filter((result): result is VerifiedCheckout => result !== undefined),
	);
	if (options.repair !== undefined) await repairEntries(inspection, options, results);
	const verified = results.filter((result): result is VerifiedCheckout => result !== undefined);
	return finalizeVerificationResult(inspection, findings, results, verified);
};
