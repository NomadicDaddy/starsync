import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { ArchiveOwner } from './archive-config.ts';
import type { ArchiveInspection } from './archive-migration.ts';
import type { Finding } from './reporting.ts';

import { CURRENT_ARCHIVE_FORMAT, parseArchiveConfig, readArchiveConfig } from './archive-config.ts';
import { createFinding } from './reporting.ts';
import { sanitizeMessage } from './secret-safety.ts';

export const MIGRATION_STATE_FILE = 'migration-state.json';

interface MigrationState {
	owner: ArchiveOwner;
}

export const getMigrationStatePath = (targetPath: string): string =>
	path.join(targetPath, '.starsync', MIGRATION_STATE_FILE);

const sameOwner = (left: ArchiveOwner, right: ArchiveOwner): boolean => left.id === right.id;

const parseMigrationState = (value: unknown): MigrationState => {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		Object.keys(value).length !== 1 ||
		!('owner' in value)
	) {
		throw new Error('Migration state must contain only owner.');
	}
	const owner = parseArchiveConfig({
		archiveFormat: CURRENT_ARCHIVE_FORMAT,
		owner: value.owner,
	}).owner;
	return { owner };
};

const readMigrationState = (targetPath: string): MigrationState | null => {
	const filePath = getMigrationStatePath(targetPath);
	if (!fs.existsSync(filePath)) return null;
	return parseMigrationState(JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown);
};

const writeMigrationState = (targetPath: string, state: MigrationState): void => {
	const filePath = getMigrationStatePath(targetPath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
	const descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
	try {
		fs.writeFileSync(descriptor, `${JSON.stringify(state, null, '\t')}\n`, 'utf-8');
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
	try {
		fs.renameSync(temporaryPath, filePath);
	} catch (err) {
		fs.rmSync(temporaryPath, { force: true });
		throw err;
	}
};

export const prepareMigrationState = (
	targetPath: string,
	inspection: ArchiveInspection,
	authenticatedOwner: ArchiveOwner
): Finding | null => {
	try {
		if (inspection.kind === 'current-managed' || inspection.kind === 'older-managed') {
			const configuredOwner = readArchiveConfig(targetPath).owner;
			if (!sameOwner(configuredOwner, authenticatedOwner)) {
				return createFinding(
					'error',
					'archive-owner-mismatch',
					`Archive belongs to GitHub account ${configuredOwner.login} (identity ${configuredOwner.id}), but the authenticated account is ${authenticatedOwner.login} (identity ${authenticatedOwner.id}).`
				);
			}
		}

		const state = readMigrationState(targetPath);
		if (state !== null) {
			if (!sameOwner(state.owner, authenticatedOwner)) {
				return createFinding(
					'error',
					'migration-owner-mismatch',
					`Migration was started by GitHub account ${state.owner.login} (identity ${state.owner.id}); authenticate as that account to resume.`
				);
			}
			return null;
		}
		if (inspection.kind !== 'current-managed') {
			writeMigrationState(targetPath, { owner: authenticatedOwner });
		}
		return null;
	} catch (err) {
		return createFinding(
			'error',
			'migration-state-invalid',
			`Cannot prepare resumable migration state: ${sanitizeMessage(
				err instanceof Error ? err.message : String(err)
			)}`
		);
	}
};
