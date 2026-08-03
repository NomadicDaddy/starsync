import type { VerifiedCheckout } from './archive-verification-checkout.ts';

import { createFinding } from './reporting.ts';

export const applyDuplicateIdentityFindings = (verified: VerifiedCheckout[]): void => {
	const counts = new Map<number, number>();
	for (const checkout of verified) {
		if (checkout.repositoryId !== null) {
			counts.set(checkout.repositoryId, (counts.get(checkout.repositoryId) ?? 0) + 1);
		}
	}
	for (const checkout of verified) {
		if (checkout.repositoryId === null || (counts.get(checkout.repositoryId) ?? 0) < 2) {
			continue;
		}
		checkout.report.findings.push(
			createFinding(
				'error',
				'duplicate-identity',
				`Repository identity ${checkout.repositoryId} is used by more than one checkout.`,
			),
		);
		checkout.report.lifecycle = 'blocked';
		checkout.report.outcome = 'failed';
	}
};
