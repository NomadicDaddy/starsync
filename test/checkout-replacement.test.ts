import { describe, expect, spyOn, test } from 'bun:test';
import fs, {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ReplacementFilesystem } from '../src/lib/checkout-replacement.ts';
import type { Finding } from '../src/lib/reporting.ts';

import { acquireArchiveLock, releaseArchiveLock } from '../src/lib/archive-lock.ts';
import {
	readReplacementRecord,
	removeReplacementRecord,
	REPLACEMENT_RECORD_DIRECTORY,
	writeReplacementRecord,
} from '../src/lib/checkout-replacement-record.ts';
import { nodeReplacementFilesystem, publishReplacement } from '../src/lib/checkout-replacement.ts';
import {
	cleanupOwnedCheckoutArtifacts,
	DAMAGED_CHECKOUT_PREFIX,
	STAGED_CHECKOUT_PREFIX,
} from '../src/lib/owned-checkout-artifacts.ts';

const BACKUP = `${DAMAGED_CHECKOUT_PREFIX}0f1e2d3c-4b5a-4968-8776-655443322110`;

interface Archive {
	backupPath: string;
	destinationPath: string;
	root: string;
	sourcePath: string;
	stagingPath: string;
	target: string;
}

// An initialized archive holding an original checkout with local work, and a staged replacement.
const createArchive = (): Archive => {
	const root = mkdtempSync(path.join(tmpdir(), 'starsync-replacement-'));
	const target = path.join(root, 'archive');
	mkdirSync(path.join(target, '.starsync'), { recursive: true });
	writeFileSync(
		path.join(target, '.starsync', 'config.json'),
		JSON.stringify({ archiveFormat: 2, owner: { id: 7, login: 'archive-owner' } }),
	);
	const sourcePath = path.join(target, 'repository--example');
	mkdirSync(path.join(sourcePath, '.git'), { recursive: true });
	writeFileSync(path.join(sourcePath, 'local-work.txt'), 'only copy');
	const stagingPath = path.join(target, `${STAGED_CHECKOUT_PREFIX}abc123`);
	mkdirSync(path.join(stagingPath, '.git'), { recursive: true });
	writeFileSync(path.join(stagingPath, 'fresh.txt'), 'fresh clone');
	return {
		backupPath: path.join(target, BACKUP),
		destinationPath: sourcePath,
		root,
		sourcePath,
		stagingPath,
		target,
	};
};

const publication = (archive: Archive) => ({
	assertDestinationAvailable: () => {
		if (existsSync(archive.destinationPath)) throw new Error('Destination occupied.');
	},
	backupPath: archive.backupPath,
	destinationPath: archive.destinationPath,
	sourcePath: archive.sourcePath,
	stagingPath: archive.stagingPath,
	targetBase: archive.target,
});

// A filesystem whose Nth rename (1-based) and removals can be made to fail.
const failingFilesystem = (failRenames: number[], failRemove = false): ReplacementFilesystem => {
	let renames = 0;
	return {
		remove: (target) => {
			if (failRemove) throw new Error('Injected removal failure.');
			nodeReplacementFilesystem.remove(target);
		},
		rename: (from, to) => {
			renames += 1;
			if (failRenames.includes(renames))
				throw new Error(`Injected rename ${renames} failure.`);
			nodeReplacementFilesystem.rename(from, to);
		},
	};
};

const cleanup = (target: string): Finding[] => {
	const acquisition = acquireArchiveLock(target, 'verify');
	if (!acquisition.ok) throw new Error(acquisition.message);
	let findings: Finding[];
	try {
		findings = cleanupOwnedCheckoutArtifacts(target, acquisition.held);
	} finally {
		releaseArchiveLock(acquisition.held);
	}
	return findings;
};

const recordFiles = (target: string): string[] => {
	const directory = path.join(target, '.starsync', REPLACEMENT_RECORD_DIRECTORY);
	return existsSync(directory) ? readdirSync(directory) : [];
};

describe('forced checkout replacement keeps the original until publication is recorded', () => {
	test('publishes, then removes the backup and its record', () => {
		const archive = createArchive();
		try {
			expect(publishReplacement(publication(archive))).toEqual({ cleanupWarning: null });
			expect(readFileSync(path.join(archive.destinationPath, 'fresh.txt'), 'utf-8')).toBe(
				'fresh clone',
			);
			expect(existsSync(archive.backupPath)).toBe(false);
			expect(recordFiles(archive.target)).toEqual([]);
		} finally {
			rmSync(archive.root, { force: true, recursive: true });
		}
	});

	test('moves the original back when publication fails', () => {
		const archive = createArchive();
		try {
			expect(() => publishReplacement(publication(archive), failingFilesystem([2]))).toThrow(
				'Injected rename 2 failure.',
			);
			expect(readFileSync(path.join(archive.sourcePath, 'local-work.txt'), 'utf-8')).toBe(
				'only copy',
			);
			expect(existsSync(archive.backupPath)).toBe(false);
			expect(recordFiles(archive.target)).toEqual([]);
		} finally {
			rmSync(archive.root, { force: true, recursive: true });
		}
	});

	test('keeps the original through a later cleanup when the rollback also fails', () => {
		const archive = createArchive();
		try {
			expect(() =>
				publishReplacement(publication(archive), failingFilesystem([2, 3])),
			).toThrow(`The original checkout could not be moved back and is kept at ${BACKUP}`);
			expect(readReplacementRecord(archive.target, BACKUP)?.state).toBe('pending');

			const findings = cleanup(archive.target);
			expect(findings.map((finding) => finding.code)).toContain('owned-checkout-backup-kept');
			expect(
				findings.find((f) => f.code === 'owned-checkout-backup-kept')?.message,
			).toContain('(previously repository--example)');
			expect(readFileSync(path.join(archive.backupPath, 'local-work.txt'), 'utf-8')).toBe(
				'only copy',
			);
		} finally {
			rmSync(archive.root, { force: true, recursive: true });
		}
	});

	test('keeps a backup left by an interruption between the two renames', () => {
		const archive = createArchive();
		try {
			// The state a stopped process leaves: the record says pending and the original sits only
			// under its backup name, with the staged clone not yet published.
			writeReplacementRecord(archive.target, {
				backup: BACKUP,
				destination: 'repository--example',
				original: 'repository--example',
				state: 'pending',
			});
			nodeReplacementFilesystem.rename(archive.sourcePath, archive.backupPath);

			const findings = cleanup(archive.target);
			expect(findings.map((finding) => finding.code)).toContain('owned-checkout-backup-kept');
			expect(existsSync(path.join(archive.backupPath, 'local-work.txt'))).toBe(true);
			expect(existsSync(archive.stagingPath)).toBe(false);
		} finally {
			rmSync(archive.root, { force: true, recursive: true });
		}
	});

	test('keeps a backup with no record, as an older StarSync leaves it', () => {
		const archive = createArchive();
		try {
			nodeReplacementFilesystem.rename(archive.sourcePath, archive.backupPath);
			const findings = cleanup(archive.target);
			const kept = findings.find((finding) => finding.code === 'owned-checkout-backup-kept');
			expect(kept?.message).toContain(BACKUP);
			expect(kept?.message).not.toContain('previously');
			expect(existsSync(path.join(archive.backupPath, 'local-work.txt'))).toBe(true);
		} finally {
			rmSync(archive.root, { force: true, recursive: true });
		}
	});

	test('keeps a backup whose record is malformed or names another backup', () => {
		const archive = createArchive();
		try {
			nodeReplacementFilesystem.rename(archive.sourcePath, archive.backupPath);
			writeReplacementRecord(archive.target, {
				backup: BACKUP,
				destination: 'repository--example',
				original: 'repository--example',
				state: 'published',
			});
			const file = path.join(
				archive.target,
				'.starsync',
				REPLACEMENT_RECORD_DIRECTORY,
				`${BACKUP}.json`,
			);
			const record = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>;
			writeFileSync(
				file,
				JSON.stringify({ ...record, backup: `${DAMAGED_CHECKOUT_PREFIX}x` }),
			);
			expect(cleanup(archive.target).map((finding) => finding.code)).toContain(
				'owned-checkout-backup-kept',
			);
			writeFileSync(file, '{ not json');
			expect(cleanup(archive.target).map((finding) => finding.code)).toContain(
				'owned-checkout-backup-kept',
			);
			expect(existsSync(path.join(archive.backupPath, 'local-work.txt'))).toBe(true);
		} finally {
			rmSync(archive.root, { force: true, recursive: true });
		}
	});

	test('removes a published backup that could not be removed at the time', () => {
		const archive = createArchive();
		try {
			const result = publishReplacement(publication(archive), failingFilesystem([], true));
			expect(result.cleanupWarning).toContain(`the replaced directory remains at ${BACKUP}`);
			expect(readReplacementRecord(archive.target, BACKUP)?.state).toBe('published');

			const findings = cleanup(archive.target);
			expect(findings.map((finding) => finding.code)).toContain(
				'owned-checkout-artifact-removed',
			);
			expect(existsSync(archive.backupPath)).toBe(false);
			expect(recordFiles(archive.target)).toEqual([]);
		} finally {
			rmSync(archive.root, { force: true, recursive: true });
		}
	});

	test('drops a record whose backup is gone', () => {
		const archive = createArchive();
		try {
			writeReplacementRecord(archive.target, {
				backup: BACKUP,
				destination: 'repository--example',
				original: 'repository--example',
				state: 'pending',
			});
			cleanup(archive.target);
			expect(recordFiles(archive.target)).toEqual([]);
		} finally {
			rmSync(archive.root, { force: true, recursive: true });
		}
	});

	test('moves nothing when the replacement record cannot be written', () => {
		const archive = createArchive();
		try {
			writeFileSync(path.join(archive.target, '.starsync', REPLACEMENT_RECORD_DIRECTORY), '');
			expect(() => publishReplacement(publication(archive))).toThrow(
				'Checkout replacement records must be in a real directory',
			);
			expect(existsSync(path.join(archive.sourcePath, 'local-work.txt'))).toBe(true);
			expect(existsSync(archive.backupPath)).toBe(false);
		} finally {
			rmSync(archive.root, { force: true, recursive: true });
		}
	});

	test('takes no publication evidence through a linked records directory', () => {
		const archive = createArchive();
		try {
			nodeReplacementFilesystem.rename(archive.sourcePath, archive.backupPath);
			// A published record for this backup, but in a folder outside the archive that the
			// records path links to.
			const elsewhere = path.join(archive.root, 'elsewhere');
			mkdirSync(elsewhere);
			const outsideRecord = path.join(elsewhere, `${BACKUP}.json`);
			writeFileSync(
				outsideRecord,
				JSON.stringify({
					backup: BACKUP,
					destination: 'repository--example',
					original: 'repository--example',
					state: 'published',
				}),
			);
			symlinkSync(
				elsewhere,
				path.join(archive.target, '.starsync', REPLACEMENT_RECORD_DIRECTORY),
				'junction',
			);

			expect(readReplacementRecord(archive.target, BACKUP)).toBeNull();
			expect(cleanup(archive.target).map((finding) => finding.code)).toContain(
				'owned-checkout-backup-kept',
			);
			expect(existsSync(path.join(archive.backupPath, 'local-work.txt'))).toBe(true);
			expect(existsSync(outsideRecord)).toBe(true);
			expect(() => removeReplacementRecord(archive.target, BACKUP)).toThrow(
				'outside a real directory',
			);
			expect(existsSync(outsideRecord)).toBe(true);
		} finally {
			rmSync(archive.root, { force: true, recursive: true });
		}
	});

	test('reports an unreadable records directory instead of stopping cleanup', () => {
		const archive = createArchive();
		writeReplacementRecord(archive.target, {
			backup: BACKUP,
			destination: 'repository--example',
			original: 'repository--example',
			state: 'pending',
		});
		const realReaddir = fs.readdirSync.bind(fs) as (
			target: fs.PathLike,
			options?: unknown,
		) => unknown;
		const readdir = spyOn(fs, 'readdirSync').mockImplementation(((
			target: fs.PathLike,
			options?: unknown,
		) => {
			if (path.basename(String(target)) === REPLACEMENT_RECORD_DIRECTORY) {
				throw Object.assign(new Error('Access denied.'), { code: 'EACCES' });
			}
			return realReaddir(target, options);
		}) as typeof fs.readdirSync);
		try {
			const findings = cleanup(archive.target);
			expect(findings.map((finding) => finding.code)).toContain(
				'checkout-replacement-records-unreadable',
			);
			expect(existsSync(archive.stagingPath)).toBe(false);
		} finally {
			readdir.mockRestore();
			rmSync(archive.root, { force: true, recursive: true });
		}
	});
});
