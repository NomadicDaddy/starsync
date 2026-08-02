import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';

import * as archiveApi from '../src/lib/archive-api.ts';
import * as archiveRename from '../src/lib/archive-rename.ts';
import * as archiveVerification from '../src/lib/archive-verification.ts';
import * as datesCommand from '../src/lib/dates-command.ts';
import * as refresh from '../src/lib/refresh.ts';

const exportNames = (module: object): string[] => Object.keys(module).sort();
const archiveApiImplementationFiles = readdirSync(new URL('../src/lib/', import.meta.url), 'utf8')
	.filter(
		(fileName) =>
			fileName.startsWith('archive-api-') &&
			fileName.endsWith('.ts') &&
			fileName !== 'archive-api-contract.ts'
	)
	.map((fileName) => `src/lib/${fileName}`);
const internalDeclarations = {
	'src/lib/archive-config.ts': ['ARCHIVE_CONFIG_FILE'],
	'src/lib/archive-dates.ts': ['readArchiveDate'],
	'src/lib/archive-inspection.ts': ['ArchiveKind'],
	'src/lib/archive-lock-metadata.ts': ['ArchiveProcessState', 'getProcessState'],
	'src/lib/archive-lock.ts': ['getArchiveLockPath'],
	'src/lib/archive-verification-repair.ts': ['CheckoutReplacer'],
	'src/lib/cli-utils.ts': ['DEFAULT_CONCURRENCY', 'SUBCOMMANDS'],
	'src/lib/dates-reporting.ts': ['DatesStatus'],
	'src/lib/reporting.ts': ['REPORT_SCHEMA_VERSION'],
	'src/lib/windows-checkout.ts': [
		'escapeSparsePattern',
		'isInvalidWindowsPath',
		'isUnrepresentablePath',
	],
} as const;

const readSource = (relativePath: string): string =>
	readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

describe('archive module facades', () => {
	test('preserves the command-level archive API exports', () => {
		expect(exportNames(archiveApi)).toEqual([
			'DEFAULT_ARCHIVE_CONCURRENCY',
			'initArchive',
			'normalizeArchiveDates',
			'renameArchive',
			'syncArchive',
			'unlockArchive',
			'verifyArchive',
		]);
	});

	test('preserves rename, verification, dates, and refresh facade exports', () => {
		expect(exportNames(archiveRename)).toEqual(['previewArchiveRenames']);
		expect(exportNames(archiveVerification)).toEqual(['verifyArchive']);
		expect(exportNames(datesCommand)).toEqual(['formatDatesTables', 'runDatesCommand']);
		expect(exportNames(refresh)).toEqual(['processRepository', 'runSyncPool']);
	});

	test('keeps archive API implementations independent from the public facade', () => {
		for (const relativePath of archiveApiImplementationFiles) {
			expect(readSource(relativePath)).not.toMatch(/from\s+['"]\.\/archive-api\.ts['"]/);
		}
	});

	test('keeps implementation-only declarations behind their module boundaries', () => {
		for (const [relativePath, symbols] of Object.entries(internalDeclarations)) {
			const source = readSource(relativePath);
			for (const symbol of symbols) {
				expect(source).not.toMatch(
					new RegExp(`\\bexport\\s+(?:const|type)\\s+${symbol}\\b`)
				);
			}
		}
		const archiveLockSource = readSource('src/lib/archive-lock.ts');
		expect(archiveLockSource).not.toMatch(/export\s*\{[^}]*\bgetProcessState\b/s);
		expect(archiveLockSource).not.toMatch(/export\s+type\s*\{[^}]*\bArchiveProcessState\b/s);
	});
});
