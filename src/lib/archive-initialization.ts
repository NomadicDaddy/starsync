import fs from 'node:fs';
import path from 'node:path';

import type { ArchiveOwner } from './archive-config.ts';
import type { CommandReport } from './reporting.ts';

import {
	CURRENT_ARCHIVE_FORMAT,
	getAuthenticatedArchiveOwner,
	writeArchiveConfig,
} from './archive-config.ts';
import { createCommandReport, createFinding } from './reporting.ts';
import { sanitizeMessage } from './secret-safety.ts';

export interface InitArchiveOptions {
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
	targetPath: string;
	token: string;
}

const getErrorMessage = (err: unknown): string =>
	err instanceof Error ? err.message : String(err);

const initFailure = (targetPath: string, code: string, message: string): CommandReport =>
	createCommandReport({
		command: 'init',
		exitCode: 1,
		findings: [createFinding('error', code, message)],
		targetPath,
	});

const interruptedReport = (targetPath: string): CommandReport =>
	createCommandReport({
		command: 'init',
		exitCode: 130,
		findings: [
			createFinding('warning', 'interrupted', 'Operation was interrupted before it started.'),
		],
		interrupted: true,
		targetPath,
	});

export const initArchive = async (options: InitArchiveOptions): Promise<CommandReport> => {
	const trimmedTarget = options.targetPath.trim();
	if (!trimmedTarget) {
		return createCommandReport({
			command: 'init',
			exitCode: 2,
			findings: [
				createFinding('error', 'invalid-target', 'targetPath must be a non-empty string.'),
			],
			targetPath: null,
		});
	}
	const targetPath = path.resolve(trimmedTarget);
	if (options.signal?.aborted) return interruptedReport(targetPath);
	if (!options.token.trim()) {
		return initFailure(targetPath, 'missing-token', 'GITHUB_TOKEN is not set.');
	}

	try {
		if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
			return initFailure(
				targetPath,
				'target-not-found',
				`Initialization requires an existing empty directory: ${targetPath}`
			);
		}
		if (fs.readdirSync(targetPath).length > 0) {
			return initFailure(
				targetPath,
				'target-not-empty',
				'Initialization requires an empty target directory.'
			);
		}
	} catch (err) {
		return initFailure(
			targetPath,
			'target-read-failed',
			`Cannot inspect target directory: ${sanitizeMessage(getErrorMessage(err))}`
		);
	}

	options.onProgress?.('Authenticating GitHub account...');
	let owner: ArchiveOwner;
	try {
		owner = await getAuthenticatedArchiveOwner(options.token);
	} catch (err) {
		return initFailure(
			targetPath,
			'github-authentication-failed',
			`Cannot authenticate GitHub account: ${sanitizeMessage(getErrorMessage(err))}`
		);
	}
	if (options.signal?.aborted) return interruptedReport(targetPath);

	try {
		if (fs.readdirSync(targetPath).length > 0) {
			return initFailure(
				targetPath,
				'target-not-empty',
				'The target directory changed during authentication and is no longer empty.'
			);
		}
		writeArchiveConfig(targetPath, owner);
	} catch (err) {
		return initFailure(
			targetPath,
			'archive-config-write-failed',
			`Cannot initialize archive: ${sanitizeMessage(getErrorMessage(err))}`
		);
	}

	options.onProgress?.(`Initialized archive for ${owner.login}.`);
	return createCommandReport({
		command: 'init',
		exitCode: 0,
		findings: [
			createFinding(
				'info',
				'archive-initialized',
				`Initialized archive format ${CURRENT_ARCHIVE_FORMAT} for GitHub account ${owner.login} (identity ${owner.id}).`
			),
		],
		targetPath,
	});
};
