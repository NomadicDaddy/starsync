import { Octokit } from '@octokit/rest';
import fs from 'node:fs';
import path from 'node:path';

import { withApiRetry } from './api-retry.ts';

export const ARCHIVE_CONFIG_DIRECTORY = '.starsync';
export const ARCHIVE_CONFIG_FILE = 'config.json';
export const CURRENT_ARCHIVE_FORMAT = 2;

export interface ArchiveOwner {
	id: number;
	login: string;
}

export interface ArchiveConfig {
	archiveFormat: number;
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

const parseOwner = (value: unknown): ArchiveOwner => {
	if (!isRecord(value) || !hasExactKeys(value, ['id', 'login'])) {
		throw new Error('Archive config owner must contain only id and login.');
	}
	if (
		typeof value.id !== 'number' ||
		!Number.isSafeInteger(value.id) ||
		value.id <= 0 ||
		typeof value.login !== 'string' ||
		!/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(value.login)
	) {
		throw new Error(
			'Archive config owner must contain a positive integer id and valid GitHub login.'
		);
	}
	return { id: value.id, login: value.login };
};

export const parseArchiveConfig = (value: unknown): ArchiveConfig => {
	if (!isRecord(value) || !hasExactKeys(value, ['archiveFormat', 'owner'])) {
		throw new Error('Archive config must contain only archiveFormat and owner.');
	}
	if (
		typeof value.archiveFormat !== 'number' ||
		!Number.isInteger(value.archiveFormat) ||
		value.archiveFormat < 1
	) {
		throw new Error('Archive config archiveFormat must be a positive integer.');
	}
	return {
		archiveFormat: value.archiveFormat,
		owner: parseOwner(value.owner),
	};
};

export const readArchiveConfig = (targetPath: string): ArchiveConfig => {
	const configPath = path.join(targetPath, ARCHIVE_CONFIG_DIRECTORY, ARCHIVE_CONFIG_FILE);
	return parseArchiveConfig(JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown);
};

export const writeArchiveConfig = (targetPath: string, owner: ArchiveOwner): void => {
	const metadataPath = path.join(targetPath, ARCHIVE_CONFIG_DIRECTORY);
	const configPath = path.join(metadataPath, ARCHIVE_CONFIG_FILE);
	let createdMetadataDirectory = false;
	try {
		fs.mkdirSync(metadataPath);
		createdMetadataDirectory = true;
		const targetEntries = fs.readdirSync(targetPath);
		if (targetEntries.length !== 1 || targetEntries[0] !== ARCHIVE_CONFIG_DIRECTORY) {
			throw new Error('The target directory changed and is no longer empty.');
		}
		fs.writeFileSync(
			configPath,
			`${JSON.stringify({ archiveFormat: CURRENT_ARCHIVE_FORMAT, owner }, null, '\t')}\n`,
			{ encoding: 'utf-8', flag: 'wx' }
		);
	} catch (err) {
		if (createdMetadataDirectory) {
			fs.rmSync(metadataPath, { force: true, recursive: true });
		}
		throw err;
	}
};

export const getAuthenticatedArchiveOwner = async (token: string): Promise<ArchiveOwner> => {
	const octokit = new Octokit({ auth: token });
	const response = await withApiRetry(() => octokit.rest.users.getAuthenticated(), {
		maxRetries: 2,
	});
	return parseOwner({ id: response.data.id, login: response.data.login });
};
