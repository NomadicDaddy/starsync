import fs from 'node:fs';
import path from 'node:path';

import type { ArchiveEntry, ArchiveInspection } from './archive-migration.ts';
import type { CheckoutReport, Finding } from './reporting.ts';

import { inspectArchive, parseGitHubRepositorySlug } from './archive-migration.ts';
import { runGit } from './git-exec.ts';
import { createFinding } from './reporting.ts';
import {
	hasEmbeddedCredentials,
	isGitHubDotComUrl,
	sanitizeMessage,
	sanitizeUrl,
	CREDENTIAL_GUIDANCE,
} from './secret-safety.ts';

export const REPOSITORY_ID_KEY = 'starsync.repository-id';
export const REPOSITORY_SLUG_KEY = 'starsync.repository-slug';

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

interface VerifiedCheckout {
	report: CheckoutReport;
	repositoryId: null | number;
}

interface GitCommandError {
	code?: number | string;
	message?: string;
	stderr?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const gitErrorDetails = (err: unknown): GitCommandError => {
	if (!isRecord(err)) return { message: String(err) };
	const details: GitCommandError = {};
	if (typeof err.code === 'number' || typeof err.code === 'string') details.code = err.code;
	if (typeof err.message === 'string') details.message = err.message;
	if (typeof err.stderr === 'string') details.stderr = err.stderr;
	return details;
};

const gitErrorMessage = (err: unknown): string => {
	const details = gitErrorDetails(err);
	return sanitizeMessage(details.stderr?.trim() || details.message || String(err));
};

const runReadOnlyGit = (checkoutPath: string, args: string[]): Promise<string> =>
	runGit(['-c', 'core.askPass=', ...args], {
		cwd: checkoutPath,
		env: { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
	});

const readOptionalGitConfig = async (checkoutPath: string, key: string): Promise<null | string> => {
	try {
		return await runReadOnlyGit(checkoutPath, ['config', '--local', '--get', key]);
	} catch (err) {
		const details = gitErrorDetails(err);
		if (Number(details.code) === 1 && !details.stderr?.trim()) return null;
		throw err;
	}
};

const expectedFolderName = (slug: string): null | string => {
	const match = slug.match(/^([a-z\d](?:[a-z\d-]*[a-z\d])?)\/([a-z\d._-]+)$/i);
	return match?.[1] && match[2] ? `${match[2]}--${match[1]}` : null;
};

const validateArchiveOwner = (targetPath: string, inspection: ArchiveInspection): Finding[] => {
	if (inspection.kind === 'legacy') {
		return [
			createFinding(
				'warning',
				'archive-owner-unbound',
				'Legacy archives do not have an owner binding; migration is required before managed operations.'
			),
		];
	}
	if (inspection.kind !== 'current-managed' && inspection.kind !== 'older-managed') return [];

	const configPath = path.join(targetPath, '.starsync', 'config.json');
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
	} catch (err) {
		return [
			createFinding(
				'error',
				'invalid-archive-owner',
				`Cannot verify archive owner binding: ${sanitizeMessage(
					err instanceof Error ? err.message : String(err)
				)}`
			),
		];
	}

	const owner = isRecord(parsed) && isRecord(parsed.owner) ? parsed.owner : null;
	const id = owner?.id;
	const login = owner?.login;
	if (
		typeof id !== 'number' ||
		!Number.isSafeInteger(id) ||
		id <= 0 ||
		typeof login !== 'string' ||
		!/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(login)
	) {
		return [
			createFinding(
				'error',
				'invalid-archive-owner',
				'Archive config must contain owner.id as a positive integer and owner.login as a valid GitHub login.'
			),
		];
	}

	return [
		createFinding(
			'info',
			'archive-owner-bound',
			`Archive is bound to GitHub account ${login} (identity ${id}).`
		),
	];
};

const failedEntry = (entry: ArchiveEntry, code: string, message: string): VerifiedCheckout => ({
	report: {
		findings: [createFinding('error', code, message)],
		lifecycle: entry.isGitCheckout ? 'blocked' : null,
		name: entry.name,
		outcome: 'failed',
		pendingRename: false,
	},
	repositoryId: null,
});

const verifyCheckout = async (
	entry: ArchiveEntry,
	archiveKind: ArchiveInspection['kind']
): Promise<VerifiedCheckout> => {
	if (!entry.isGitCheckout) {
		return failedEntry(
			entry,
			'unrelated-archive-entry',
			'Archive entry is not a Git checkout.'
		);
	}

	const findings: Finding[] = [];
	let blocked = false;
	let repositoryId: null | number = null;
	let repositorySlug: null | string = null;
	let originSlug: { owner: string; repository: string } | null = null;

	try {
		await runReadOnlyGit(entry.path, ['fsck', '--full', '--no-dangling']);
		findings.push(
			createFinding('info', 'git-integrity-valid', 'Git object integrity is valid.')
		);
	} catch (err) {
		blocked = true;
		findings.push(
			createFinding(
				'error',
				'git-integrity-failed',
				`Git object integrity check failed: ${gitErrorMessage(err)}`
			)
		);
	}

	if (entry.gitError || !entry.origin) {
		blocked = true;
		findings.push(
			createFinding(
				'error',
				'origin-unverifiable',
				`Cannot read remote.origin.url${entry.gitError ? `: ${entry.gitError}` : '.'}`
			)
		);
	} else if (hasEmbeddedCredentials(entry.origin)) {
		blocked = true;
		findings.push(
			createFinding(
				'error',
				'credential-bearing-origin',
				`Remote origin contains embedded credentials: ${sanitizeUrl(entry.origin)}. ${CREDENTIAL_GUIDANCE}`
			)
		);
	} else if (!isGitHubDotComUrl(entry.origin)) {
		blocked = true;
		findings.push(
			createFinding(
				'error',
				'invalid-origin',
				`Remote origin is not GitHub.com: ${sanitizeUrl(entry.origin)}`
			)
		);
	} else {
		originSlug = parseGitHubRepositorySlug(entry.origin);
		if (!originSlug) {
			blocked = true;
			findings.push(
				createFinding(
					'error',
					'invalid-origin',
					`Cannot parse a GitHub repository slug from ${sanitizeUrl(entry.origin)}`
				)
			);
		}
	}

	try {
		const status = await runReadOnlyGit(entry.path, ['status', '--porcelain']);
		if (status.length > 0) {
			blocked = true;
			findings.push(
				createFinding(
					'error',
					'checkout-blocked',
					'Local changes make this a blocked checkout.'
				)
			);
		}
	} catch (err) {
		blocked = true;
		findings.push(
			createFinding(
				'error',
				'checkout-state-unverifiable',
				`Cannot verify checkout state: ${gitErrorMessage(err)}`
			)
		);
	}

	let rawId: null | string = null;
	let rawSlug: null | string = null;
	let identityMetadataReadable = true;
	try {
		[rawId, rawSlug] = await Promise.all([
			readOptionalGitConfig(entry.path, REPOSITORY_ID_KEY),
			readOptionalGitConfig(entry.path, REPOSITORY_SLUG_KEY),
		]);
	} catch (err) {
		identityMetadataReadable = false;
		blocked = true;
		findings.push(
			createFinding(
				'error',
				'identity-metadata-unverifiable',
				`Cannot read checkout identity metadata: ${gitErrorMessage(err)}`
			)
		);
	}

	if (identityMetadataReadable && (rawId === null || rawSlug === null)) {
		const severity = archiveKind === 'legacy' ? 'warning' : 'error';
		if (severity === 'error') blocked = true;
		findings.push(
			createFinding(
				severity,
				'missing-identity-metadata',
				`Checkout must define ${REPOSITORY_ID_KEY} and ${REPOSITORY_SLUG_KEY} in local Git config.`
			)
		);
	} else if (rawId !== null && rawSlug !== null) {
		const parsedId = Number(rawId);
		const proposedName = expectedFolderName(rawSlug);
		if (!Number.isSafeInteger(parsedId) || parsedId <= 0 || proposedName === null) {
			blocked = true;
			findings.push(
				createFinding(
					'error',
					'invalid-identity-metadata',
					'Checkout identity must contain a positive integer repository ID and an owner/repository slug.'
				)
			);
		} else {
			repositoryId = parsedId;
			repositorySlug = rawSlug;
			if (originSlug) {
				if (
					`${originSlug.owner}/${originSlug.repository}`.toLowerCase() !==
					rawSlug.toLowerCase()
				) {
					blocked = true;
					findings.push(
						createFinding(
							'error',
							'identity-origin-mismatch',
							`Identity slug ${rawSlug} does not match origin ${originSlug.owner}/${originSlug.repository}.`
						)
					);
				}
			}
		}
	}

	const renameSource = repositorySlug ?? originSlug;
	const proposedName =
		typeof renameSource === 'string'
			? expectedFolderName(renameSource)
			: renameSource
				? `${renameSource.repository}--${renameSource.owner}`
				: null;
	const pendingRename =
		proposedName !== null && proposedName.toLowerCase() !== entry.name.toLowerCase();
	if (pendingRename) {
		findings.push(
			createFinding(
				'warning',
				'pending-rename',
				`Checkout folder should be named ${proposedName}.`
			)
		);
	}

	return {
		report: {
			findings,
			lifecycle: blocked ? 'blocked' : 'active',
			name: entry.name,
			outcome: blocked ? 'failed' : 'current',
			pendingRename,
		},
		repositoryId,
	};
};

const applyDuplicateIdentityFindings = (verified: VerifiedCheckout[]): void => {
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
				`Repository identity ${checkout.repositoryId} is used by more than one checkout.`
			)
		);
		checkout.report.lifecycle = 'blocked';
		checkout.report.outcome = 'failed';
	}
};

const addSuccessFindings = (verified: VerifiedCheckout[]): void => {
	for (const checkout of verified) {
		if (checkout.report.findings.every((finding) => finding.severity !== 'error')) {
			checkout.report.findings.push(
				createFinding('info', 'checkout-verified', 'Checkout verification passed.')
			);
		}
	}
};

export const verifyArchive = async (
	targetPath: string,
	options: ArchiveVerificationOptions = {}
): Promise<ArchiveVerificationResult> => {
	let inspection: ArchiveInspection;
	try {
		inspection = inspectArchive(targetPath);
	} catch (err) {
		return {
			checkouts: [],
			exitCode: 1,
			findings: [
				createFinding(
					'error',
					'archive-inspection-failed',
					`Cannot inspect archive: ${sanitizeMessage(
						err instanceof Error ? err.message : String(err)
					)}`
				),
			],
			interrupted: false,
		};
	}

	const findings = [...inspection.findings, ...validateArchiveOwner(targetPath, inspection)];
	if (
		inspection.kind === 'invalid' ||
		inspection.kind === 'newer-managed' ||
		inspection.kind === 'uninitialized'
	) {
		return { checkouts: [], exitCode: 1, findings, interrupted: false };
	}

	const results: (undefined | VerifiedCheckout)[] = new Array(inspection.entries.length);
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		while (true) {
			if (options.isInterruptionRequested?.()) return;
			const index = nextIndex++;
			if (index >= inspection.entries.length) return;
			const entry = inspection.entries[index]!;
			options.onProgress?.(
				`Verifying ${index + 1}/${inspection.entries.length} — ${entry.name}`
			);
			results[index] = await verifyCheckout(entry, inspection.kind);
		}
	};
	const workerCount = Math.min(VERIFICATION_CONCURRENCY, inspection.entries.length);
	await Promise.all(Array.from({ length: workerCount }, () => worker()));

	const verified = results.filter((result): result is VerifiedCheckout => result !== undefined);
	applyDuplicateIdentityFindings(verified);
	addSuccessFindings(verified);
	const interruptedReports = inspection.entries.flatMap((entry, index): CheckoutReport[] =>
		results[index] === undefined
			? [
					{
						findings: [
							createFinding(
								'warning',
								'interrupted-before-verification',
								'Checkout was not verified because interruption was requested.'
							),
						],
						lifecycle: entry.isGitCheckout ? 'active' : null,
						name: entry.name,
						outcome: 'skipped',
						pendingRename: false,
					},
				]
			: []
	);
	const interrupted = interruptedReports.length > 0;
	if (interrupted) {
		findings.push(
			createFinding(
				'warning',
				'interrupted',
				'Archive verification was interrupted; results are partial.'
			)
		);
	}
	const checkouts = [...verified.map(({ report }) => report), ...interruptedReports].sort(
		(left, right) => left.name.localeCompare(right.name)
	);
	const hasErrors =
		findings.some((finding) => finding.severity === 'error') ||
		checkouts.some((checkout) =>
			checkout.findings.some((finding) => finding.severity === 'error')
		);

	return {
		checkouts,
		exitCode: interrupted ? 130 : hasErrors ? 1 : 0,
		findings,
		interrupted,
	};
};
