import type { ArchiveEntry, ArchiveKind } from './archive-migration.ts';
import type { CheckoutReport, Finding } from './reporting.ts';

import { parseGitHubRepositorySlug } from './archive-migration.ts';
import {
	canonicalCheckoutName,
	REPOSITORY_ID_KEY,
	REPOSITORY_SLUG_KEY,
} from './checkout-identity.ts';
import { runGit } from './git-exec.ts';
import { createFinding } from './reporting.ts';
import {
	hasEmbeddedCredentials,
	isGitHubDotComUrl,
	sanitizeMessage,
	sanitizeUrl,
	CREDENTIAL_GUIDANCE,
} from './secret-safety.ts';

export interface VerifiedCheckout {
	report: CheckoutReport;
	repositoryId: null | number;
	repositorySlug: null | string;
}

interface GitCommandError {
	code?: number | string;
	message?: string;
	stderr?: string;
}

interface VerificationState {
	blocked: boolean;
	findings: Finding[];
	originSlug: { owner: string; repository: string } | null;
	repositoryId: null | number;
	repositorySlug: null | string;
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

const failEntry = (entry: ArchiveEntry, code: string, message: string): VerifiedCheckout => ({
	report: {
		findings: [createFinding('error', code, message)],
		lifecycle: entry.isGitCheckout ? 'blocked' : null,
		name: entry.name,
		outcome: 'failed',
		pendingRename: false,
	},
	repositoryId: null,
	repositorySlug: null,
});

const addBlockedFinding = (state: VerificationState, code: string, message: string): void => {
	state.blocked = true;
	state.findings.push(createFinding('error', code, message));
};

const verifyGitIntegrity = async (entry: ArchiveEntry, state: VerificationState): Promise<void> => {
	try {
		await runReadOnlyGit(entry.path, ['fsck', '--full', '--no-dangling']);
		state.findings.push(
			createFinding('info', 'git-integrity-valid', 'Git object integrity is valid.')
		);
	} catch (err) {
		addBlockedFinding(
			state,
			'git-integrity-failed',
			`Git object integrity check failed: ${gitErrorMessage(err)}`
		);
	}
};

const verifyOrigin = (entry: ArchiveEntry, state: VerificationState): void => {
	if (entry.gitError || !entry.origin) {
		addBlockedFinding(
			state,
			'origin-unverifiable',
			`Cannot read remote.origin.url${entry.gitError ? `: ${entry.gitError}` : '.'}`
		);
		return;
	}
	if (hasEmbeddedCredentials(entry.origin)) {
		addBlockedFinding(
			state,
			'credential-bearing-origin',
			`Remote origin contains embedded credentials: ${sanitizeUrl(entry.origin)}. ${CREDENTIAL_GUIDANCE}`
		);
		return;
	}
	if (!isGitHubDotComUrl(entry.origin)) {
		addBlockedFinding(
			state,
			'invalid-origin',
			`Remote origin is not GitHub.com: ${sanitizeUrl(entry.origin)}`
		);
		return;
	}
	state.originSlug = parseGitHubRepositorySlug(entry.origin);
	if (state.originSlug === null) {
		addBlockedFinding(
			state,
			'invalid-origin',
			`Cannot parse a GitHub repository slug from ${sanitizeUrl(entry.origin)}`
		);
	}
};

const verifyCheckoutState = async (
	entry: ArchiveEntry,
	state: VerificationState
): Promise<void> => {
	try {
		const status = await runReadOnlyGit(entry.path, ['status', '--porcelain']);
		if (status.length > 0) {
			addBlockedFinding(
				state,
				'checkout-blocked',
				'Local changes make this a blocked checkout.'
			);
		}
	} catch (err) {
		addBlockedFinding(
			state,
			'checkout-state-unverifiable',
			`Cannot verify checkout state: ${gitErrorMessage(err)}`
		);
	}
};

const readIdentity = async (
	entry: ArchiveEntry,
	state: VerificationState
): Promise<[null | string, null | string] | null> => {
	try {
		return await Promise.all([
			readOptionalGitConfig(entry.path, REPOSITORY_ID_KEY),
			readOptionalGitConfig(entry.path, REPOSITORY_SLUG_KEY),
		]);
	} catch (err) {
		addBlockedFinding(
			state,
			'identity-metadata-unverifiable',
			`Cannot read checkout identity metadata: ${gitErrorMessage(err)}`
		);
		return null;
	}
};

const recordIdentity = (rawId: string, rawSlug: string, state: VerificationState): void => {
	const parsedId = Number(rawId);
	if (
		!Number.isSafeInteger(parsedId) ||
		parsedId <= 0 ||
		canonicalCheckoutName(rawSlug) === null
	) {
		addBlockedFinding(
			state,
			'invalid-identity-metadata',
			'Checkout identity must contain a positive integer repository ID and an owner/repository slug.'
		);
		return;
	}
	state.repositoryId = parsedId;
	state.repositorySlug = rawSlug;
	const originSlug = state.originSlug;
	if (
		originSlug &&
		`${originSlug.owner}/${originSlug.repository}`.toLowerCase() !== rawSlug.toLowerCase()
	) {
		addBlockedFinding(
			state,
			'identity-origin-mismatch',
			`Identity slug ${rawSlug} does not match origin ${originSlug.owner}/${originSlug.repository}.`
		);
	}
};

const verifyIdentity = async (
	entry: ArchiveEntry,
	archiveKind: ArchiveKind,
	state: VerificationState
): Promise<void> => {
	const identity = await readIdentity(entry, state);
	if (identity === null) return;
	const [rawId, rawSlug] = identity;
	if (rawId === null || rawSlug === null) {
		const severity = archiveKind === 'legacy' ? 'warning' : 'error';
		if (severity === 'error') state.blocked = true;
		state.findings.push(
			createFinding(
				severity,
				'missing-identity-metadata',
				`Checkout must define ${REPOSITORY_ID_KEY} and ${REPOSITORY_SLUG_KEY} in local Git config.`
			)
		);
		return;
	}
	recordIdentity(rawId, rawSlug, state);
};

const getPendingRename = (entry: ArchiveEntry, state: VerificationState): boolean => {
	const source = state.repositorySlug ?? state.originSlug;
	const proposedName =
		typeof source === 'string'
			? canonicalCheckoutName(source)
			: source
				? `${source.repository}--${source.owner}`
				: null;
	const pendingRename =
		proposedName !== null && proposedName.toLowerCase() !== entry.name.toLowerCase();
	if (pendingRename) {
		state.findings.push(
			createFinding(
				'warning',
				'pending-rename',
				`Checkout folder should be named ${proposedName}.`
			)
		);
	}
	return pendingRename;
};

export const verifyCheckout = async (
	entry: ArchiveEntry,
	archiveKind: ArchiveKind
): Promise<VerifiedCheckout> => {
	if (!entry.isGitCheckout) {
		return failEntry(entry, 'unrelated-archive-entry', 'Archive entry is not a Git checkout.');
	}
	const state: VerificationState = {
		blocked: false,
		findings: [],
		originSlug: null,
		repositoryId: null,
		repositorySlug: null,
	};
	await verifyGitIntegrity(entry, state);
	verifyOrigin(entry, state);
	await verifyCheckoutState(entry, state);
	await verifyIdentity(entry, archiveKind, state);
	const pendingRename = getPendingRename(entry, state);
	return {
		report: {
			findings: state.findings,
			lifecycle: state.blocked ? 'blocked' : 'active',
			name: entry.name,
			outcome: state.blocked ? 'failed' : 'current',
			pendingRename,
		},
		repositoryId: state.repositoryId,
		repositorySlug: state.repositorySlug,
	};
};
