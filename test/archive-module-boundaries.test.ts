import { describe, expect, test } from 'bun:test';

import * as archiveApi from '../src/lib/archive-api.ts';
import * as archiveRename from '../src/lib/archive-rename.ts';
import * as archiveVerification from '../src/lib/archive-verification.ts';
import * as datesCommand from '../src/lib/dates-command.ts';
import * as refresh from '../src/lib/refresh.ts';

const exportNames = (module: object): string[] => Object.keys(module).sort();

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
});
