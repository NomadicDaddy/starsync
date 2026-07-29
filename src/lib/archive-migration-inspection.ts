import fs from 'node:fs';
import path from 'node:path';

import type { ArchiveEntry, ArchiveInspection, ArchiveKind } from './archive-migration.ts';
import type { Finding } from './reporting.ts';

import { CURRENT_ARCHIVE_FORMAT, readArchiveConfig } from './archive-config.ts';
import { readMigrationGit } from './archive-migration-resolution.ts';
import { createFinding } from './reporting.ts';
import { isGitHubDotComUrl, sanitizeMessage, sanitizeUrl } from './secret-safety.ts';

const readArchiveEntry = (targetPath: string, entry: fs.Dirent): ArchiveEntry => {
	const entryPath = path.join(targetPath, entry.name);
	const isGitCheckout = entry.isDirectory() && fs.existsSync(path.join(entryPath, '.git'));
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
			origin: readMigrationGit(entryPath, ['config', '--get', 'remote.origin.url']),
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
};

const readArchiveEntries = (targetPath: string): ArchiveEntry[] =>
	fs
		.readdirSync(targetPath, { withFileTypes: true })
		.filter((entry) => entry.name !== '.starsync')
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((entry) => readArchiveEntry(targetPath, entry));

const managedInspection = (
	archiveFormat: number,
	entries: ArchiveEntry[],
	kind: ArchiveKind,
	finding: Finding
): ArchiveInspection => ({ archiveFormat, entries, findings: [finding], kind });

const inspectManagedFormat = (
	archiveFormat: number,
	entries: ArchiveEntry[]
): ArchiveInspection => {
	if (archiveFormat > CURRENT_ARCHIVE_FORMAT) {
		return managedInspection(
			archiveFormat,
			entries,
			'newer-managed',
			createFinding(
				'error',
				'archive-format-newer',
				`Archive format ${archiveFormat} is newer than supported format ${CURRENT_ARCHIVE_FORMAT}.`
			)
		);
	}
	if (archiveFormat === CURRENT_ARCHIVE_FORMAT) {
		return managedInspection(
			archiveFormat,
			entries,
			'current-managed',
			createFinding(
				'info',
				'archive-format-current',
				`Archive format ${archiveFormat} is current.`
			)
		);
	}
	return managedInspection(
		archiveFormat,
		entries,
		'older-managed',
		createFinding(
			'warning',
			'archive-format-older',
			`Archive format ${archiveFormat} is older than supported format ${CURRENT_ARCHIVE_FORMAT}; only verification and migration preview are allowed.`
		)
	);
};

const invalidManagedInspection = (entries: ArchiveEntry[], message: string): ArchiveInspection => ({
	archiveFormat: null,
	entries,
	findings: [createFinding('error', 'invalid-archive-config', message)],
	kind: 'invalid',
});

const readManagedArchive = (targetPath: string, entries: ArchiveEntry[]): ArchiveInspection => {
	const configPath = path.join(targetPath, '.starsync', 'config.json');
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
	} catch (err) {
		return invalidManagedInspection(
			entries,
			`Cannot read archive config: ${sanitizeMessage(err instanceof Error ? err.message : String(err))}`
		);
	}
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		!('archiveFormat' in parsed) ||
		!Number.isInteger(parsed.archiveFormat) ||
		(parsed.archiveFormat as number) < 1
	) {
		return invalidManagedInspection(
			entries,
			'Archive config must contain a positive integer archiveFormat.'
		);
	}
	return inspectManagedFormat(parsed.archiveFormat as number, entries);
};

const inspectConfiglessArchive = (entries: ArchiveEntry[]): ArchiveInspection => {
	const count = entries.filter(
		(entry) => entry.origin && isGitHubDotComUrl(sanitizeUrl(entry.origin))
	).length;
	if (count > 0) {
		return {
			archiveFormat: 1,
			entries,
			findings: [
				createFinding(
					'info',
					'legacy-archive-recognized',
					`Recognized a legacy archive containing ${count} GitHub.com checkout${count === 1 ? '' : 's'}.`
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
	return fs.existsSync(configPath)
		? readManagedArchive(targetPath, entries)
		: inspectConfiglessArchive(entries);
};

const findOriginUrl = (lines: string[]): null | string => {
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
	return null;
};

const resolveGitConfigPath = (checkoutPath: string): null | string => {
	const dotGitPath = path.join(checkoutPath, '.git');
	if (!fs.statSync(dotGitPath).isFile()) return path.join(dotGitPath, 'config');
	const pointer = fs.readFileSync(dotGitPath, 'utf-8').match(/^gitdir:\s*(.+)$/im)?.[1];
	return pointer ? path.join(path.resolve(checkoutPath, pointer.trim()), 'config') : null;
};

const readOriginFromGitConfig = (checkoutPath: string): null | string => {
	try {
		const configPath = resolveGitConfigPath(checkoutPath);
		if (configPath === null) return null;
		const lines = fs.readFileSync(configPath, 'utf-8').split(/\r?\n/);
		return findOriginUrl(lines);
	} catch {
		return null;
	}
};

const inspectUnconfiguredModification = (targetPath: string): Finding => {
	const hasLegacyCheckout = fs
		.readdirSync(targetPath, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.some((entry) => {
			const origin = readOriginFromGitConfig(path.join(targetPath, entry.name));
			return origin !== null && isGitHubDotComUrl(sanitizeUrl(origin));
		});
	return hasLegacyCheckout
		? createFinding(
				'error',
				'legacy-archive-read-only',
				'A legacy archive must be migrated before modifying commands can use it.'
			)
		: createFinding(
				'error',
				'archive-uninitialized',
				'The target is not an initialized managed archive. Run starsync init first.'
			);
};

const inspectManagedModification = (targetPath: string): Finding | null => {
	const inspection = readManagedArchive(targetPath, []);
	if (inspection.kind === 'older-managed') {
		return createFinding(
			'error',
			'older-archive-read-only',
			'An older managed archive must be migrated before modifying commands can use it.'
		);
	}
	if (inspection.kind === 'newer-managed' || inspection.kind === 'invalid') {
		return inspection.findings.find((finding) => finding.severity === 'error') ?? null;
	}
	try {
		readArchiveConfig(targetPath);
		return null;
	} catch (err) {
		return createFinding(
			'error',
			'invalid-archive-config',
			`Cannot read archive config: ${sanitizeMessage(err instanceof Error ? err.message : String(err))}`
		);
	}
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
	return fs.existsSync(configPath)
		? inspectManagedModification(targetPath)
		: inspectUnconfiguredModification(targetPath);
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
