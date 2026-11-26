import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { ReplacedCheckout } from './checkout-replacement.ts';

import { readArchiveConfig } from './archive-config.ts';
import { cloneManagedCheckout } from './checkout-clone.ts';
import {
	canonicalCheckoutName,
	readCheckoutIdentity,
	writeCheckoutIdentity,
} from './checkout-identity.ts';
import { publishReplacement } from './checkout-replacement.ts';
import { sameFilesystemEntry } from './filesystem-identity.ts';
import { isTransientGitError, runGit } from './git-exec.ts';
import {
	DAMAGED_CHECKOUT_PREFIX,
	isOwnedStagingCheckoutName,
	STAGED_CHECKOUT_PREFIX,
} from './owned-checkout-artifacts.ts';
import {
	extractHost,
	hasEmbeddedCredentials,
	isArchiveHostUrl,
	sanitizeMessage,
	sanitizeUrl,
} from './secret-safety.ts';

export interface StagedCheckoutRepository {
	cloneUrl: string;
	folderName: string;
	repositoryId: number;
	repositorySlug: string;
}

export type StagedCheckoutReplacement = { sourceFolderName: string } & StagedCheckoutRepository;
export interface StagedCheckoutOptions {
	archiveOwnerId: number;
}

export type { ReplacedCheckout } from './checkout-replacement.ts';

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const normalizeRepositoryUrl = (url: string): string =>
	url
		.trim()
		.toLowerCase()
		.replace(/\.git$/, '')
		.replace(/\/+$/, '');

const repositorySlugFromCloneUrl = (url: string): null | string => {
	try {
		const parsed = new URL(url);
		const segments = parsed.pathname.split('/').filter(Boolean);
		if (segments.length !== 2 || parsed.search || parsed.hash) return null;
		const owner = segments[0];
		const repository = segments[1]?.replace(/\.git$/i, '');
		return owner && repository ? `${owner}/${repository}` : null;
	} catch {
		return null;
	}
};

const assertRepositoryRequest = (
	repository: StagedCheckoutRepository,
	targetBase: string,
): void => {
	if (
		!Number.isSafeInteger(repository.repositoryId) ||
		repository.repositoryId <= 0 ||
		canonicalCheckoutName(repository.repositorySlug) !== repository.folderName ||
		repositorySlugFromCloneUrl(repository.cloneUrl)?.toLowerCase() !==
			repository.repositorySlug.toLowerCase()
	) {
		throw new Error(
			'New managed checkout requires a positive Repository Identity, matching host origin, and its canonical repository--owner folder.',
		);
	}
	if (
		hasEmbeddedCredentials(repository.cloneUrl) ||
		!isArchiveHostUrl(repository.cloneUrl, readArchiveConfig(targetBase).host ?? 'github.com')
	) {
		throw new Error(
			`Repository origin does not match archive host: ${sanitizeUrl(repository.cloneUrl)}`,
		);
	}
};

const assertArchiveOwner = (targetBase: string, archiveOwnerId: number): void => {
	const configuredOwner = readArchiveConfig(targetBase).owner;
	if (configuredOwner.id !== archiveOwnerId) {
		throw new Error(
			`Archive owner identity changed before checkout publication (expected ${archiveOwnerId}, found ${configuredOwner.id}).`,
		);
	}
};

const assertDestinationAvailable = (destinationPath: string, folderName: string): void => {
	if (fs.existsSync(destinationPath)) {
		throw new Error(`Canonical checkout folder ${folderName} is already occupied.`);
	}
};

const assertReplacementSource = (sourcePath: string, sourceFolderName: string): void => {
	if (
		!sourceFolderName ||
		path.basename(sourceFolderName) !== sourceFolderName ||
		!fs.existsSync(path.join(sourcePath, '.git'))
	) {
		throw new Error(`Anomalous checkout ${sourceFolderName} is no longer present.`);
	}
};
const assertReplacementDestinationAvailable = (
	sourcePath: string,
	destinationPath: string,
	folderName: string,
): void => {
	// A case-only rename on a case-insensitive directory finds its own source at the destination;
	// a distinct directory there, even one differing only in case, is a different checkout.
	if (fs.existsSync(destinationPath) && !sameFilesystemEntry(sourcePath, destinationPath)) {
		throw new Error(`Canonical checkout folder ${folderName} is already occupied.`);
	}
};

const removeOwnedStagingDirectory = (targetBase: string, stagingPath: string): void => {
	const resolvedTarget = path.resolve(targetBase);
	const resolvedStaging = path.resolve(stagingPath);
	if (
		path.dirname(resolvedStaging) !== resolvedTarget ||
		!isOwnedStagingCheckoutName(path.basename(resolvedStaging))
	) {
		throw new Error('Refusing to remove a directory that StarSync does not own.');
	}
	fs.rmSync(resolvedStaging, { force: true, recursive: true });
};

const tryRemoveOwnedStagingDirectory = (targetBase: string, stagingPath: string): Error | null => {
	try {
		removeOwnedStagingDirectory(targetBase, stagingPath);
		return null;
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}
};

const validateStagedCheckout = async (
	stagingPath: string,
	repository: StagedCheckoutRepository,
): Promise<void> => {
	if (!fs.existsSync(path.join(stagingPath, '.git'))) {
		throw new Error('Clone completed without creating a usable Git checkout.');
	}
	const origin = await runGit(['config', '--local', '--get', 'remote.origin.url'], {
		cwd: stagingPath,
	});
	if (
		hasEmbeddedCredentials(origin) ||
		extractHost(origin) !== extractHost(repository.cloneUrl) ||
		normalizeRepositoryUrl(origin) !== normalizeRepositoryUrl(repository.cloneUrl)
	) {
		throw new Error(
			`Staged checkout origin does not match the requested repository: ${sanitizeUrl(origin)}`,
		);
	}
	await runGit(['fsck', '--full'], { cwd: stagingPath });
	const status = await runGit(['status', '--porcelain'], { cwd: stagingPath });
	if (status) throw new Error('Staged checkout contains local changes after cloning.');
	await writeCheckoutIdentity(stagingPath, {
		repositoryId: repository.repositoryId,
		repositorySlug: repository.repositorySlug,
	});
	const identity = await readCheckoutIdentity(stagingPath);
	if (
		identity?.repositoryId !== repository.repositoryId ||
		identity.repositorySlug !== repository.repositorySlug
	) {
		throw new Error('Staged checkout identity validation failed.');
	}
};

const cloneValidatedCheckout = async (
	repository: StagedCheckoutRepository,
	targetBase: string,
	options: StagedCheckoutOptions,
): Promise<string> => {
	for (let attempt = 0; attempt < 2; attempt++) {
		assertArchiveOwner(targetBase, options.archiveOwnerId);
		const stagingPath = fs.mkdtempSync(path.join(targetBase, STAGED_CHECKOUT_PREFIX));
		try {
			await cloneManagedCheckout(repository.cloneUrl, path.basename(stagingPath), targetBase);
			await validateStagedCheckout(stagingPath, repository);
			assertArchiveOwner(targetBase, options.archiveOwnerId);
			return stagingPath;
		} catch (err) {
			const cleanupError = tryRemoveOwnedStagingDirectory(targetBase, stagingPath);
			const sanitizedFailure = sanitizeMessage(errorMessage(err));
			if (cleanupError !== null) {
				throw new Error(
					`${sanitizedFailure} StarSync could not remove its staging directory: ${sanitizeMessage(
						errorMessage(cleanupError),
					)}`,
					{ cause: err },
				);
			}
			if (attempt === 0 && isTransientGitError(sanitizedFailure)) {
				await sleep(1000);
				continue;
			}
			throw new Error(sanitizedFailure, { cause: err });
		}
	}
	throw new Error('Checkout clone attempts were exhausted.');
};

export const createStagedCheckout = async (
	repository: StagedCheckoutRepository,
	targetBase: string,
	options: StagedCheckoutOptions,
): Promise<void> => {
	assertRepositoryRequest(repository, targetBase);
	const destinationPath = path.join(targetBase, repository.folderName);
	assertArchiveOwner(targetBase, options.archiveOwnerId);
	assertDestinationAvailable(destinationPath, repository.folderName);
	const stagingPath = await cloneValidatedCheckout(repository, targetBase, options);
	try {
		assertArchiveOwner(targetBase, options.archiveOwnerId);
		assertDestinationAvailable(destinationPath, repository.folderName);
		assertRepositoryRequest(repository, targetBase);
		fs.renameSync(stagingPath, destinationPath);
	} catch (err) {
		const cleanupError = tryRemoveOwnedStagingDirectory(targetBase, stagingPath);
		if (cleanupError !== null) {
			throw new Error(
				`${sanitizeMessage(errorMessage(err))} StarSync could not remove its staging directory: ${sanitizeMessage(
					errorMessage(cleanupError),
				)}`,
				{ cause: err },
			);
		}
		throw err;
	}
};

export const replaceAnomalousCheckout = async (
	repository: StagedCheckoutReplacement,
	targetBase: string,
	options: StagedCheckoutOptions,
): Promise<ReplacedCheckout> => {
	assertRepositoryRequest(repository, targetBase);
	const sourcePath = path.join(targetBase, repository.sourceFolderName);
	const destinationPath = path.join(targetBase, repository.folderName);
	assertReplacementSource(sourcePath, repository.sourceFolderName);
	assertReplacementDestinationAvailable(sourcePath, destinationPath, repository.folderName);
	const stagingPath = await cloneValidatedCheckout(repository, targetBase, options);
	const backupPath = path.join(targetBase, `${DAMAGED_CHECKOUT_PREFIX}${randomUUID()}`);
	try {
		assertArchiveOwner(targetBase, options.archiveOwnerId);
		assertReplacementSource(sourcePath, repository.sourceFolderName);
		assertReplacementDestinationAvailable(sourcePath, destinationPath, repository.folderName);
		assertRepositoryRequest(repository, targetBase);
		return publishReplacement({
			assertDestinationAvailable: () =>
				assertDestinationAvailable(destinationPath, repository.folderName),
			backupPath,
			destinationPath,
			sourcePath,
			stagingPath,
			targetBase,
		});
	} catch (err) {
		const cleanupError = tryRemoveOwnedStagingDirectory(targetBase, stagingPath);
		const cleanupMessage =
			cleanupError === null
				? ''
				: ` Staging cleanup failed: ${sanitizeMessage(errorMessage(cleanupError))}`;
		throw new Error(`${sanitizeMessage(errorMessage(err))}${cleanupMessage}`, { cause: err });
	}
};
