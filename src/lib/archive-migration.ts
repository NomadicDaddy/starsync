import { Octokit } from '@octokit/rest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { CheckoutReport, Finding, MigrationPreview } from './reporting.ts';

import { withApiRetry } from './api-retry.ts';
import { createFinding } from './reporting.ts';
import {
	hasEmbeddedCredentials,
	isGitHubDotComUrl,
	sanitizeMessage,
	sanitizeUrl,
} from './secret-safety.ts';

export const CURRENT_ARCHIVE_FORMAT = 2;
const MIGRATION_PREVIEW_CONCURRENCY = 4;

type ArchiveKind =
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

interface ResolvedEntry {
	blockedReason: null | string;
	entry: ArchiveEntry;
	preview: MigrationPreview;
}

const gitRead = (checkoutPath: string, args: string[]): string =>
	execFileSync('git', ['-c', 'core.askPass=', ...args], {
		cwd: checkoutPath,
		encoding: 'utf-8',
		env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();

const readArchiveEntries = (targetPath: string): ArchiveEntry[] =>
	fs
		.readdirSync(targetPath, { withFileTypes: true })
		.filter((entry) => entry.name !== '.starsync')
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((entry): ArchiveEntry => {
			const entryPath = path.join(targetPath, entry.name);
			const isGitCheckout =
				entry.isDirectory() && fs.existsSync(path.join(entryPath, '.git'));
			if (!isGitCheckout) {
				return {
					gitError: null,
					isGitCheckout: false,
					name: entry.name,
					origin: null,
					path: entryPath,
				};
			}

			try {
				return {
					gitError: null,
					isGitCheckout: true,
					name: entry.name,
					origin: gitRead(entryPath, ['config', '--get', 'remote.origin.url']),
					path: entryPath,
				};
			} catch (err) {
				return {
					gitError: sanitizeMessage(err instanceof Error ? err.message : String(err)),
					isGitCheckout: true,
					name: entry.name,
					origin: null,
					path: entryPath,
				};
			}
		});

const readManagedArchive = (targetPath: string, entries: ArchiveEntry[]): ArchiveInspection => {
	const configPath = path.join(targetPath, '.starsync', 'config.json');
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
	} catch (err) {
		return {
			archiveFormat: null,
			entries,
			findings: [
				createFinding(
					'error',
					'invalid-archive-config',
					`Cannot read archive config: ${sanitizeMessage(err instanceof Error ? err.message : String(err))}`
				),
			],
			kind: 'invalid',
		};
	}

	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		!('archiveFormat' in parsed) ||
		!Number.isInteger(parsed.archiveFormat) ||
		(parsed.archiveFormat as number) < 1
	) {
		return {
			archiveFormat: null,
			entries,
			findings: [
				createFinding(
					'error',
					'invalid-archive-config',
					'Archive config must contain a positive integer archiveFormat.'
				),
			],
			kind: 'invalid',
		};
	}

	const archiveFormat = parsed.archiveFormat as number;
	if (archiveFormat > CURRENT_ARCHIVE_FORMAT) {
		return {
			archiveFormat,
			entries,
			findings: [
				createFinding(
					'error',
					'archive-format-newer',
					`Archive format ${archiveFormat} is newer than supported format ${CURRENT_ARCHIVE_FORMAT}.`
				),
			],
			kind: 'newer-managed',
		};
	}

	if (archiveFormat === CURRENT_ARCHIVE_FORMAT) {
		return {
			archiveFormat,
			entries,
			findings: [
				createFinding(
					'info',
					'archive-format-current',
					`Archive format ${archiveFormat} is current; no migration is required.`
				),
			],
			kind: 'current-managed',
		};
	}

	return {
		archiveFormat,
		entries,
		findings: [
			createFinding(
				'warning',
				'archive-format-older',
				`Archive format ${archiveFormat} is older than supported format ${CURRENT_ARCHIVE_FORMAT}; only verification and migration preview are allowed.`
			),
		],
		kind: 'older-managed',
	};
};

export const inspectArchive = (targetPath: string): ArchiveInspection => {
	if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
		return {
			archiveFormat: null,
			entries: [],
			findings: [
				createFinding(
					'error',
					'target-not-found',
					`Archive path does not exist: ${targetPath}`
				),
			],
			kind: 'invalid',
		};
	}

	const entries = readArchiveEntries(targetPath);
	const configPath = path.join(targetPath, '.starsync', 'config.json');
	if (fs.existsSync(configPath)) return readManagedArchive(targetPath, entries);

	const githubCheckouts = entries.filter((entry) => {
		if (!entry.origin) return false;
		return isGitHubDotComUrl(sanitizeUrl(entry.origin));
	});
	if (githubCheckouts.length > 0) {
		return {
			archiveFormat: 1,
			entries,
			findings: [
				createFinding(
					'info',
					'legacy-archive-recognized',
					`Recognized a legacy archive containing ${githubCheckouts.length} GitHub.com checkout${githubCheckouts.length === 1 ? '' : 's'}.`
				),
			],
			kind: 'legacy',
		};
	}

	const message =
		entries.length === 0
			? 'The configless directory is empty and is not a legacy archive.'
			: 'The configless directory contains no recognized GitHub.com checkouts and is not a legacy archive.';
	return {
		archiveFormat: null,
		entries,
		findings: [createFinding('error', 'archive-uninitialized', message)],
		kind: 'uninitialized',
	};
};

const readOriginFromGitConfig = (checkoutPath: string): null | string => {
	const dotGitPath = path.join(checkoutPath, '.git');
	let configPath = path.join(dotGitPath, 'config');
	try {
		if (fs.statSync(dotGitPath).isFile()) {
			const pointer = fs.readFileSync(dotGitPath, 'utf-8').match(/^gitdir:\s*(.+)$/im)?.[1];
			if (!pointer) return null;
			configPath = path.join(path.resolve(checkoutPath, pointer.trim()), 'config');
		}
		const lines = fs.readFileSync(configPath, 'utf-8').split(/\r?\n/);
		let inOrigin = false;
		for (const line of lines) {
			if (/^\s*\[/.test(line)) {
				inOrigin = /^\s*\[remote\s+"origin"\]\s*$/i.test(line);
				continue;
			}
			if (!inOrigin) continue;
			const value = line.match(/^\s*url\s*=\s*(.+?)\s*$/i)?.[1];
			if (value) return value;
		}
	} catch {
		return null;
	}
	return null;
};

const getArchiveModificationFindingImpl = (targetPath: string): Finding | null => {
	if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
		return createFinding(
			'error',
			'target-not-found',
			`Archive path does not exist: ${targetPath}`
		);
	}

	const configPath = path.join(targetPath, '.starsync', 'config.json');
	if (!fs.existsSync(configPath)) {
		const hasLegacyCheckout = fs
			.readdirSync(targetPath, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.some((entry) => {
				const origin = readOriginFromGitConfig(path.join(targetPath, entry.name));
				return origin !== null && isGitHubDotComUrl(sanitizeUrl(origin));
			});
		if (!hasLegacyCheckout) return null;
		return createFinding(
			'error',
			'legacy-archive-read-only',
			'A legacy archive may only be verified or previewed with migrate during this release.'
		);
	}

	const inspection = readManagedArchive(targetPath, []);
	if (inspection.kind === 'older-managed') {
		return createFinding(
			'error',
			'older-archive-read-only',
			'An older managed archive may only be verified or previewed with migrate.'
		);
	}
	if (inspection.kind === 'newer-managed' || inspection.kind === 'invalid') {
		return inspection.findings.find((finding) => finding.severity === 'error') ?? null;
	}
	if (inspection.kind === 'current-managed') {
		return createFinding(
			'error',
			'managed-archive-unavailable',
			'Modifying managed archives is not available in this release.'
		);
	}
	return null;
};

export const getArchiveModificationFinding = (targetPath: string): Finding | null => {
	try {
		return getArchiveModificationFindingImpl(targetPath);
	} catch (err) {
		return createFinding(
			'error',
			'archive-inspection-failed',
			`Cannot inspect archive: ${sanitizeMessage(err instanceof Error ? err.message : String(err))}`
		);
	}
};

export const parseGitHubRepositorySlug = (
	origin: string
): { owner: string; repository: string } | null => {
	const sanitized = sanitizeUrl(origin);
	let pathname: string;
	if (/^https?:\/\//i.test(sanitized) || /^ssh:\/\//i.test(sanitized)) {
		try {
			const parsed = new URL(sanitized);
			if (parsed.search || parsed.hash) return null;
			pathname = parsed.pathname;
		} catch {
			return null;
		}
	} else {
		const match = sanitized.match(/^git@[^:]+:(.+)$/i);
		if (!match?.[1]) return null;
		pathname = match[1];
	}

	const parts = pathname
		.replace(/^\/+/, '')
		.replace(/\.git$/i, '')
		.split('/')
		.filter(Boolean);
	if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
	return { owner: parts[0], repository: parts[1] };
};

const failedCheckout = (entry: ArchiveEntry, code: string, message: string): CheckoutReport => ({
	findings: [createFinding('error', code, message)],
	lifecycle: entry.isGitCheckout ? 'blocked' : null,
	migration: {
		classification: 'failed',
		proposedName: null,
		repositoryId: null,
		repositorySlug: null,
	},
	name: entry.name,
	outcome: 'failed',
	pendingRename: false,
});

const resolveEntry = async (
	entry: ArchiveEntry,
	resolveRepository: RepositoryResolver
): Promise<CheckoutReport | ResolvedEntry> => {
	if (!entry.isGitCheckout) {
		return failedCheckout(
			entry,
			'unrelated-archive-entry',
			'Archive entry is not a Git checkout.'
		);
	}
	if (entry.gitError || !entry.origin) {
		return failedCheckout(
			entry,
			'origin-unverifiable',
			`Cannot read remote.origin.url${entry.gitError ? `: ${entry.gitError}` : '.'}`
		);
	}
	if (hasEmbeddedCredentials(entry.origin)) {
		return failedCheckout(
			entry,
			'credential-bearing-origin',
			`Remote origin contains embedded credentials: ${sanitizeUrl(entry.origin)}`
		);
	}
	if (!isGitHubDotComUrl(entry.origin)) {
		return failedCheckout(
			entry,
			'invalid-origin',
			`Remote origin is not GitHub.com: ${sanitizeUrl(entry.origin)}`
		);
	}

	const slug = parseGitHubRepositorySlug(entry.origin);
	if (!slug) {
		return failedCheckout(
			entry,
			'invalid-origin',
			`Cannot parse a GitHub repository slug from ${sanitizeUrl(entry.origin)}`
		);
	}

	let repository: ResolvedRepository;
	try {
		repository = await resolveRepository(slug.owner, slug.repository);
	} catch (err) {
		return failedCheckout(
			entry,
			'identity-resolution-failed',
			`Cannot resolve repository identity: ${sanitizeMessage(err instanceof Error ? err.message : String(err))}`
		);
	}
	if (
		!Number.isSafeInteger(repository.id) ||
		repository.id <= 0 ||
		!repository.name ||
		!repository.owner ||
		!repository.slug ||
		/[\\/]/.test(repository.name) ||
		/[\\/]/.test(repository.owner) ||
		repository.slug.toLowerCase() !== `${repository.owner}/${repository.name}`.toLowerCase()
	) {
		return failedCheckout(
			entry,
			'invalid-repository-identity',
			'Repository identity response contains invalid or inconsistent fields.'
		);
	}

	const proposedName = `${repository.name}--${repository.owner}`;
	let blockedReason: null | string = null;
	try {
		const status = gitRead(entry.path, ['status', '--porcelain']);
		if (status.length > 0) blockedReason = 'Local changes prevent a safe folder rename.';
	} catch (err) {
		blockedReason = `Local state cannot be verified: ${sanitizeMessage(err instanceof Error ? err.message : String(err))}`;
	}

	return {
		blockedReason,
		entry,
		preview: {
			classification: 'safely-migratable',
			proposedName,
			repositoryId: repository.id,
			repositorySlug: repository.slug,
		},
	};
};

const normalizeFolderName = (name: string): string => name.toLowerCase();

const classifyResolvedEntries = (
	resolvedEntries: ResolvedEntry[],
	allEntryNames: Set<string>
): CheckoutReport[] => {
	const identityCounts = new Map<number, number>();
	const proposedNameCounts = new Map<string, number>();
	for (const resolved of resolvedEntries) {
		const repositoryId = resolved.preview.repositoryId;
		if (repositoryId !== null) {
			identityCounts.set(repositoryId, (identityCounts.get(repositoryId) ?? 0) + 1);
		}
		const proposedName = resolved.preview.proposedName;
		if (proposedName !== null) {
			const key = normalizeFolderName(proposedName);
			proposedNameCounts.set(key, (proposedNameCounts.get(key) ?? 0) + 1);
		}
	}

	return resolvedEntries.map(({ blockedReason, entry, preview }): CheckoutReport => {
		const repositoryId = preview.repositoryId!;
		const proposedName = preview.proposedName!;
		const proposedKey = normalizeFolderName(proposedName);
		const currentKey = normalizeFolderName(entry.name);
		const duplicateIdentity = (identityCounts.get(repositoryId) ?? 0) > 1;
		const duplicateDestination = (proposedNameCounts.get(proposedKey) ?? 0) > 1;
		const occupiedDestination = proposedKey !== currentKey && allEntryNames.has(proposedKey);

		if (duplicateIdentity || duplicateDestination || occupiedDestination) {
			const message = duplicateIdentity
				? `Repository identity ${repositoryId} is resolved by more than one checkout.`
				: `Proposed folder ${proposedName} collides with another archive entry.`;
			return {
				findings: [
					createFinding(
						'error',
						duplicateIdentity ? 'duplicate-identity' : 'migration-name-collision',
						message
					),
				],
				lifecycle: 'blocked',
				migration: { ...preview, classification: 'failed' },
				name: entry.name,
				outcome: 'failed',
				pendingRename: proposedName !== entry.name,
			};
		}

		if (blockedReason) {
			return {
				findings: [createFinding('error', 'adopted-but-blocked', blockedReason)],
				lifecycle: 'blocked',
				migration: { ...preview, classification: 'adopted-but-blocked' },
				name: entry.name,
				outcome: 'skipped',
				pendingRename: proposedName !== entry.name,
				plannedOutcome: 'updated',
			};
		}

		if (proposedName !== entry.name) {
			return {
				findings: [
					createFinding(
						'warning',
						'pending-rename',
						`Checkout would be renamed to ${proposedName}.`
					),
				],
				lifecycle: 'active',
				migration: { ...preview, classification: 'pending-rename' },
				name: entry.name,
				outcome: 'skipped',
				pendingRename: true,
				plannedOutcome: 'updated',
			};
		}

		return {
			findings: [
				createFinding(
					'info',
					'safely-migratable',
					`Checkout identity ${repositoryId} can be recorded without a folder rename.`
				),
			],
			lifecycle: 'active',
			migration: preview,
			name: entry.name,
			outcome: 'skipped',
			pendingRename: false,
			plannedOutcome: 'updated',
		};
	});
};

export const previewArchiveMigration = async (
	targetPath: string,
	resolveRepository: RepositoryResolver,
	options: MigrationPreviewOptions = {}
): Promise<MigrationPreviewResult> => {
	const inspection = inspectArchive(targetPath);
	if (
		inspection.kind === 'current-managed' ||
		inspection.kind === 'invalid' ||
		inspection.kind === 'newer-managed' ||
		inspection.kind === 'uninitialized'
	) {
		return {
			checkouts: [],
			exitCode: inspection.findings.some((finding) => finding.severity === 'error') ? 1 : 0,
			findings: inspection.findings,
			interrupted: false,
		};
	}

	const entryResults: (CheckoutReport | ResolvedEntry | undefined)[] = new Array(
		inspection.entries.length
	);
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		while (true) {
			if (options.isInterruptionRequested?.()) return;
			const index = nextIndex++;
			if (index >= inspection.entries.length) return;
			const entry = inspection.entries[index]!;
			options.onProgress?.(
				`Inspecting ${index + 1}/${inspection.entries.length} — ${entry.name}`
			);
			entryResults[index] = await resolveEntry(entry, resolveRepository);
		}
	};
	const workerCount = Math.min(MIGRATION_PREVIEW_CONCURRENCY, inspection.entries.length);
	await Promise.all(Array.from({ length: workerCount }, () => worker()));

	const immediateReports = entryResults.filter(
		(result): result is CheckoutReport => result !== undefined && !('preview' in result)
	);
	const resolvedEntries = entryResults.filter(
		(result): result is ResolvedEntry => result !== undefined && 'preview' in result
	);
	const interruptedEntries = inspection.entries.flatMap((entry, index): CheckoutReport[] =>
		entryResults[index] === undefined
			? [
					{
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
					},
				]
			: []
	);
	const interrupted = interruptedEntries.length > 0;

	const allEntryNames = new Set(
		inspection.entries.map((entry) => normalizeFolderName(entry.name))
	);
	const checkouts = [
		...classifyResolvedEntries(resolvedEntries, allEntryNames),
		...immediateReports,
		...interruptedEntries,
	].sort((left, right) => left.name.localeCompare(right.name));
	const hasErrors = checkouts.some((checkout) =>
		checkout.findings.some((finding) => finding.severity === 'error')
	);
	let exitCode: 0 | 1 | 130 = 0;
	if (interrupted) {
		exitCode = 130;
	} else if (hasErrors) {
		exitCode = 1;
	}
	return {
		checkouts,
		exitCode,
		findings: interrupted
			? [
					...inspection.findings,
					createFinding(
						'warning',
						'interrupted',
						'Migration preview was interrupted; results are partial.'
					),
				]
			: inspection.findings,
		interrupted,
	};
};

export const createGitHubRepositoryResolver = (token: string): RepositoryResolver => {
	const octokit = new Octokit({ auth: token });
	return async (owner, repository) => {
		const response = await withApiRetry(
			() => octokit.rest.repos.get({ owner, repo: repository }),
			{ maxRetries: 2 }
		);
		return {
			id: response.data.id,
			name: response.data.name,
			owner: response.data.owner.login,
			slug: response.data.full_name,
		};
	};
};
