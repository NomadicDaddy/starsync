import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { Finding } from './reporting.ts';

import { CURRENT_ARCHIVE_FORMAT, readArchiveConfig } from './archive-config.ts';
import { buildGitEnvironment } from './git-exec.ts';
import {
	checkoutBoundaryProblem,
	GIT_BOUNDARY_QUERY,
	GIT_OUTSIDE_CHECKOUT,
	gitPathsInside,
} from './managed-checkout-inspection.ts';
import { isOwnedCheckoutArtifactName } from './owned-checkout-artifacts.ts';
import { createFinding } from './reporting.ts';
import { sanitizeMessage } from './secret-safety.ts';

type ArchiveKind = 'current' | 'invalid' | 'uninitialized' | 'unsupported';

export interface ArchiveEntry {
	/** Why Git work in this entry could reach outside the archive; set entries are never acted on. */
	boundaryError: null | string;
	/**
	 * Why Git couldn't say where this checkout's work tree and metadata are, as for a damaged
	 * repository. No further Git runs in it: verification reports it as checkout-boundary-unverified,
	 * which forced repair never replaces, so the folder and its local work stay for a person.
	 */
	boundaryUnverified: null | string;
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

const readGit = (checkoutPath: string, args: string[]): string =>
	execFileSync('git', ['-c', 'core.askPass=', ...args], {
		cwd: checkoutPath,
		encoding: 'utf-8',
		env: buildGitEnvironment(process.env, { GIT_OPTIONAL_LOCKS: '0' }),
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	}).trim();

type ArchiveEntryFields = Partial<
	Pick<
		ArchiveEntry,
		'boundaryError' | 'boundaryUnverified' | 'gitError' | 'isGitCheckout' | 'origin'
	>
>;

const archiveEntry = (
	targetPath: string,
	name: string,
	fields: ArchiveEntryFields = {},
): ArchiveEntry => ({
	boundaryError: null,
	boundaryUnverified: null,
	gitError: null,
	isGitCheckout: false,
	origin: null,
	...fields,
	name,
	path: path.join(targetPath, name),
});

// Git's own answer for where the checkout's work tree and metadata are, asked before any other Git
// read, so a redirected checkout is never read and one Git can't open is read no further.
const gitBoundaryFields = (entryPath: string): ArchiveEntryFields | null => {
	let answer: string;
	try {
		answer = readGit(entryPath, GIT_BOUNDARY_QUERY);
	} catch (err) {
		const reason = sanitizeMessage(err instanceof Error ? err.message : String(err));
		return { boundaryUnverified: reason, gitError: reason, isGitCheckout: true };
	}
	return gitPathsInside(answer, entryPath)
		? null
		: { boundaryError: GIT_OUTSIDE_CHECKOUT, isGitCheckout: true };
};

const readArchiveEntry = (targetPath: string, entry: fs.Dirent): ArchiveEntry => {
	const entryPath = path.join(targetPath, entry.name);
	const hasGitEntry = fs.existsSync(path.join(entryPath, '.git'));
	const boundaryError =
		entry.isDirectory() || entry.isSymbolicLink()
			? checkoutBoundaryProblem(targetPath, entry.name)
			: null;
	if (boundaryError !== null) {
		return archiveEntry(targetPath, entry.name, { boundaryError, isGitCheckout: hasGitEntry });
	}
	if (!entry.isDirectory() || !hasGitEntry) return archiveEntry(targetPath, entry.name);
	const gitBoundary = gitBoundaryFields(entryPath);
	if (gitBoundary !== null) return archiveEntry(targetPath, entry.name, gitBoundary);
	try {
		return archiveEntry(targetPath, entry.name, {
			isGitCheckout: true,
			origin: readGit(entryPath, ['config', '--get', 'remote.origin.url']),
		});
	} catch (err) {
		return archiveEntry(targetPath, entry.name, {
			gitError: sanitizeMessage(err instanceof Error ? err.message : String(err)),
			isGitCheckout: true,
		});
	}
};

const readArchiveEntries = (targetPath: string): ArchiveEntry[] =>
	fs
		.readdirSync(targetPath, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.name !== '.starsync' &&
				!(entry.isDirectory() && isOwnedCheckoutArtifactName(entry.name)),
		)
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((entry) => readArchiveEntry(targetPath, entry));

const failure = (
	kind: Exclude<ArchiveKind, 'current'>,
	code: string,
	message: string,
	archiveFormat: null | number = null,
): ArchiveInspection => ({
	archiveFormat,
	entries: [],
	findings: [createFinding('error', code, message)],
	kind,
});

const currentArchiveContract = (): ArchiveInspection => ({
	archiveFormat: CURRENT_ARCHIVE_FORMAT,
	entries: [],
	findings: [
		createFinding(
			'info',
			'archive-format-current',
			`Archive format ${CURRENT_ARCHIVE_FORMAT} is current.`,
		),
	],
	kind: 'current',
});

const readConfiguredArchiveContract = (targetPath: string): ArchiveInspection => {
	const configPath = path.join(targetPath, '.starsync', 'config.json');
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
	} catch (err) {
		return failure(
			'invalid',
			'invalid-archive-config',
			`Cannot read archive config: ${sanitizeMessage(err instanceof Error ? err.message : String(err))}`,
		);
	}
	const archiveFormat =
		typeof parsed === 'object' && parsed !== null && 'archiveFormat' in parsed
			? parsed.archiveFormat
			: null;
	if (typeof archiveFormat === 'number' && archiveFormat !== CURRENT_ARCHIVE_FORMAT) {
		return failure(
			'unsupported',
			'archive-format-unsupported',
			`Archive format ${archiveFormat} is unsupported; StarSync requires format ${CURRENT_ARCHIVE_FORMAT}.`,
			archiveFormat,
		);
	}
	try {
		readArchiveConfig(targetPath);
	} catch (err) {
		return failure(
			'invalid',
			'invalid-archive-config',
			`Cannot read archive config: ${sanitizeMessage(err instanceof Error ? err.message : String(err))}`,
		);
	}
	return currentArchiveContract();
};

const inspectArchiveContract = (targetPath: string): ArchiveInspection => {
	if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
		return failure('invalid', 'target-not-found', `Archive path does not exist: ${targetPath}`);
	}
	const configPath = path.join(targetPath, '.starsync', 'config.json');
	return fs.existsSync(configPath)
		? readConfiguredArchiveContract(targetPath)
		: failure(
				'uninitialized',
				'archive-uninitialized',
				'The target is not an initialized format-2 archive. Initialize an empty directory with starsync init; if this directory contains files, preserve or move it aside and rebuild the archive in a different empty directory.',
			);
};

export const inspectArchive = (targetPath: string): ArchiveInspection => {
	const inspection = inspectArchiveContract(targetPath);
	return inspection.kind === 'current'
		? { ...inspection, entries: readArchiveEntries(targetPath) }
		: inspection;
};

export const getArchiveModificationFinding = (targetPath: string): Finding | null => {
	try {
		const inspection = inspectArchiveContract(targetPath);
		return inspection.kind === 'current'
			? null
			: (inspection.findings.find((finding) => finding.severity === 'error') ?? null);
	} catch (err) {
		return createFinding(
			'error',
			'archive-inspection-failed',
			`Cannot inspect archive: ${sanitizeMessage(err instanceof Error ? err.message : String(err))}`,
		);
	}
};
