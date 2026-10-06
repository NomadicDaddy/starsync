import fs from 'node:fs';
import path from 'node:path';

import type { ArchiveHost } from './archive-host.ts';

import { parseArchiveHost } from './archive-host.ts';
import { createRepositoryHost } from './repository-host.ts';

export const ARCHIVE_CONFIG_DIRECTORY = '.starsync';
const ARCHIVE_CONFIG_FILE = 'config.json';
export const CURRENT_ARCHIVE_FORMAT = 2;

export interface ArchiveOwner {
	id: number;
	login: string;
}

export interface ArchiveConfig {
	archiveFormat: number;
	host?: ArchiveHost;
	owner: ArchiveOwner;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, expected: string[]): boolean => {
	const actual = Object.keys(value).sort();
	return (
		actual.length === expected.length && actual.every((key, index) => key === expected[index])
	);
};

const parseOwner = (value: unknown, host: ArchiveHost): ArchiveOwner => {
	if (!isRecord(value) || !hasExactKeys(value, ['id', 'login'])) {
		throw new Error('Archive config owner must contain only id and login.');
	}
	if (
		typeof value.id !== 'number' ||
		!Number.isSafeInteger(value.id) ||
		value.id <= 0 ||
		typeof value.login !== 'string' ||
		!(
			host === 'github.com'
				? /^(?!.*--)[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i
				: /^[a-z\d][a-z\d_.-]*$/i
		).test(value.login)
	) {
		throw new Error(
			'Archive config owner must contain a positive integer id and valid host login.',
		);
	}
	return { id: value.id, login: value.login };
};

export const parseArchiveConfig = (value: unknown): ArchiveConfig => {
	if (
		!isRecord(value) ||
		!(
			hasExactKeys(value, ['archiveFormat', 'owner']) ||
			hasExactKeys(value, ['archiveFormat', 'host', 'owner'])
		)
	) {
		throw new Error('Archive config must contain only archiveFormat, owner and optional host.');
	}
	if (typeof value.archiveFormat !== 'number' || !Number.isInteger(value.archiveFormat)) {
		throw new Error('Archive config archiveFormat must be an integer.');
	}
	if (value.archiveFormat !== CURRENT_ARCHIVE_FORMAT) {
		throw new Error(
			`Archive format ${value.archiveFormat} is unsupported; StarSync requires format ${CURRENT_ARCHIVE_FORMAT}.`,
		);
	}
	return {
		archiveFormat: value.archiveFormat,
		...('host' in value ? { host: parseArchiveHost(value.host) } : {}),
		owner: parseOwner(value.owner, parseArchiveHost(value.host)),
	};
};

export const readArchiveConfig = (targetPath: string): ArchiveConfig => {
	const configPath = path.join(targetPath, ARCHIVE_CONFIG_DIRECTORY, ARCHIVE_CONFIG_FILE);
	return parseArchiveConfig(JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown);
};

export const writeArchiveConfig = (
	targetPath: string,
	owner: ArchiveOwner,
	operationLockPath?: string,
	host: ArchiveHost = 'github.com',
): void => {
	const metadataPath = path.join(targetPath, ARCHIVE_CONFIG_DIRECTORY);
	const configPath = path.join(metadataPath, ARCHIVE_CONFIG_FILE);
	let configCreated = false;
	let createdMetadataDirectory = false;
	try {
		if (operationLockPath === undefined) {
			fs.mkdirSync(metadataPath);
			createdMetadataDirectory = true;
		} else {
			if (path.dirname(operationLockPath) !== metadataPath) {
				throw new Error('The operation lock is outside the archive metadata directory.');
			}
			const metadataEntries = fs.readdirSync(metadataPath);
			if (
				metadataEntries.length !== 1 ||
				metadataEntries[0] !== path.basename(operationLockPath)
			) {
				throw new Error('The archive metadata directory changed during initialization.');
			}
		}
		const targetEntries = fs.readdirSync(targetPath);
		if (targetEntries.length !== 1 || targetEntries[0] !== ARCHIVE_CONFIG_DIRECTORY) {
			throw new Error('The target directory changed and is no longer empty.');
		}
		const descriptor = fs.openSync(configPath, 'wx', 0o600);
		configCreated = true;
		try {
			fs.writeFileSync(
				descriptor,
				`${JSON.stringify({ archiveFormat: CURRENT_ARCHIVE_FORMAT, host, owner }, null, '\t')}\n`,
				'utf-8',
			);
			fs.fsyncSync(descriptor);
		} finally {
			fs.closeSync(descriptor);
		}
	} catch (err) {
		if (createdMetadataDirectory) {
			fs.rmSync(metadataPath, { force: true, recursive: true });
		} else if (configCreated) {
			fs.rmSync(configPath, { force: true });
		}
		throw err;
	}
};

export const getAuthenticatedArchiveOwner = async (
	token: string,
	host: ArchiveHost = 'github.com',
): Promise<ArchiveOwner> =>
	parseOwner(await createRepositoryHost(host, token).authenticate(), host);
