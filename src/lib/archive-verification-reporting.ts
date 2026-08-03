import fs from 'node:fs';
import path from 'node:path';

import type { ArchiveConfig } from './archive-config.ts';
import type { ArchiveInspection } from './archive-inspection.ts';
import type { VerifiedCheckout } from './archive-verification-checkout.ts';
import type { ArchiveVerificationResult } from './archive-verification.ts';
import type { CheckoutReport, Finding } from './reporting.ts';

import { parseArchiveConfig } from './archive-config.ts';
import { createFinding } from './reporting.ts';
import { sanitizeMessage } from './secret-safety.ts';

const parseArchiveOwner = (targetPath: string): ArchiveConfig | Finding => {
	const configPath = path.join(targetPath, '.starsync', 'config.json');
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
	} catch (err) {
		return createFinding(
			'error',
			'invalid-archive-owner',
			`Cannot verify archive owner binding: ${sanitizeMessage(err instanceof Error ? err.message : String(err))}`,
		);
	}
	try {
		return parseArchiveConfig(parsed);
	} catch (err) {
		return createFinding(
			'error',
			'invalid-archive-owner',
			`Archive owner binding is invalid: ${sanitizeMessage(err instanceof Error ? err.message : String(err))}`,
		);
	}
};

export const validateArchiveOwner = (
	targetPath: string,
	inspection: ArchiveInspection,
): Finding[] => {
	if (inspection.kind !== 'current') return [];
	const config = parseArchiveOwner(targetPath);
	if ('severity' in config) return [config];
	return [
		createFinding(
			'info',
			'archive-owner-bound',
			`Archive is bound to GitHub account ${config.owner.login} (identity ${config.owner.id}).`,
		),
	];
};

export const createInspectionFailureResult = (err: unknown): ArchiveVerificationResult => ({
	checkouts: [],
	exitCode: 1,
	findings: [
		createFinding(
			'error',
			'archive-inspection-failed',
			`Cannot inspect archive: ${sanitizeMessage(err instanceof Error ? err.message : String(err))}`,
		),
	],
	interrupted: false,
});

const createInterruptedReports = (
	inspection: ArchiveInspection,
	results: (undefined | VerifiedCheckout)[],
): CheckoutReport[] =>
	inspection.entries.flatMap((entry, index) =>
		results[index] === undefined
			? [
					{
						findings: [
							createFinding(
								'warning',
								'interrupted-before-verification',
								'Checkout was not verified because interruption was requested.',
							),
						],
						lifecycle: entry.isGitCheckout ? 'active' : null,
						name: entry.name,
						outcome: 'skipped',
						pendingRename: false,
					},
				]
			: [],
	);

const addSuccessFindings = (verified: VerifiedCheckout[]): void => {
	for (const checkout of verified) {
		if (
			checkout.report.lifecycle !== null &&
			checkout.report.findings.every((finding) => finding.severity !== 'error')
		) {
			checkout.report.findings.push(
				createFinding('info', 'checkout-verified', 'Checkout verification passed.'),
			);
		}
	}
};

export const finalizeVerificationResult = (
	inspection: ArchiveInspection,
	findings: Finding[],
	results: (undefined | VerifiedCheckout)[],
	verified: VerifiedCheckout[],
): ArchiveVerificationResult => {
	addSuccessFindings(verified);
	const interruptedReports = createInterruptedReports(inspection, results);
	const interrupted = interruptedReports.length > 0;
	if (interrupted) {
		findings.push(
			createFinding(
				'warning',
				'interrupted',
				'Archive verification was interrupted; results are partial.',
			),
		);
	}
	const checkouts = [...verified.map(({ report }) => report), ...interruptedReports].sort(
		(left, right) => left.name.localeCompare(right.name),
	);
	const hasErrors =
		findings.some((finding) => finding.severity === 'error') ||
		checkouts.some((checkout) =>
			checkout.findings.some((finding) => finding.severity === 'error'),
		);
	return {
		checkouts,
		exitCode: interrupted ? 130 : hasErrors ? 1 : 0,
		findings,
		interrupted,
	};
};
