import { describe, expect, test } from 'bun:test';

import * as archiveApi from '../src/lib/archive-api.ts';
import * as archiveMigration from '../src/lib/archive-migration.ts';
import * as archiveVerification from '../src/lib/archive-verification.ts';
import * as datesCommand from '../src/lib/dates-command.ts';
import * as refresh from '../src/lib/refresh.ts';

const exportNames = (module: object): string[] => Object.keys(module).sort();

describe('archive module facades', () => {
	test('preserves the command-level archive API exports', () => {
		expect(exportNames(archiveApi)).toEqual([
			'DEFAULT_ARCHIVE_CONCURRENCY',
			'initArchive',
			'migrateArchive',
			'normalizeArchiveDates',
			'syncArchive',
			'unlockArchive',
			'verifyArchive',
		]);
	});

	test('preserves migration, verification, dates, and refresh facade exports', () => {
		expect(exportNames(archiveMigration)).toEqual([
			'createGitHubRepositoryResolver',
			'getArchiveModificationFinding',
			'inspectArchive',
			'parseGitHubRepositorySlug',
			'previewArchiveMigration',
		]);
		expect(exportNames(archiveVerification)).toEqual(['verifyArchive']);
		expect(exportNames(datesCommand)).toEqual(['formatDatesTables', 'runDatesCommand']);
		expect(exportNames(refresh)).toEqual(['processRepository', 'runSyncPool']);
	});
});
