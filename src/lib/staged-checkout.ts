import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readArchiveConfig } from './archive-config.ts';
import { cloneManagedCheckout } from './checkout-clone.ts';
import {
	canonicalCheckoutName,
	readCheckoutIdentity,
	writeCheckoutIdentity,
} from './checkout-identity.ts';
import { isTransientGitError, runGit } from './git-exec.ts';
import {
	DAMAGED_CHECKOUT_PREFIX,
	isOwnedStagingCheckoutName,
	STAGED_CHECKOUT_PREFIX,
} from './owned-checkout-artifacts.ts';
import {
	hasEmbeddedCredentials,
	isGitHubDotComUrl,
	sanitizeMessage,
	sanitizeUrl,
} from './secret-safety.ts';

export interface StagedCheckoutRepository {
	cloneUrl: string;
	folderName: string;
	repositoryId: number;
	repositorySlug: string;
}

export interface StagedCheckoutOptions {
	archiveOwnerId: number;
}

export interface ReplacedCheckout {
	cleanupWarning: null | string;
}

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

const assertRepositoryRequest = (repository: StagedCheckoutRepository): void => {
	if (
		!Number.isSafeInteger(repository.repositoryId) ||
		repository.repositoryId <= 0 ||
		canonicalCheckoutName(repository.repositorySlug) !== repository.folderName ||
		repositorySlugFromCloneUrl(repository.cloneUrl)?.toLowerCase() !==
			repository.repositorySlug.toLowerCase()
	) {
		throw new Error(
			'New managed checkout requires a positive Repository Identity, matching GitHub.com origin, and its canonical repository--owner folder.'
		);
	}
	if (hasEmbeddedCredentials(repository.cloneUrl) || !isGitHubDotComUrl(repository.cloneUrl)) {
		throw new Error(
			`Repository origin is not a credential-free GitHub.com URL: ${sanitizeUrl(
				repository.cloneUrl
			)}`
		);
	}
};

const assertArchiveOwner = (targetBase: string, archiveOwnerId: number): void => {
	const configuredOwner = readArchiveConfig(targetBase).owner;
	if (configuredOwner.id !== archiveOwnerId) {
		throw new Error(
			`Archive owner identity changed before checkout publication (expected ${archiveOwnerId}, found ${configuredOwner.id}).`
		);
	}
};

const assertDestinationAvailable = (destinationPath: string, folderName: string): void => {
	if (fs.existsSync(destinationPath)) {
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
	repository: StagedCheckoutRepository
): Promise<void> => {
	if (!fs.existsSync(path.join(stagingPath, '.git'))) {
		throw new Error('Clone completed without creating a usable Git checkout.');
	}

	const origin = await runGit(['config', '--local', '--get', 'remote.origin.url'], {
		cwd: stagingPath,
	});
	if (
		hasEmbeddedCredentials(origin) ||
		!isGitHubDotComUrl(origin) ||
		normalizeRepositoryUrl(origin) !== normalizeRepositoryUrl(repository.cloneUrl)
	) {
		throw new Error(
			`Staged checkout origin does not match the expected credential-free GitHub.com repository: ${sanitizeUrl(
				origin
			)}`
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
	options: StagedCheckoutOptions
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
						errorMessage(cleanupError)
					)}`,
					{ cause: err }
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

/**
 * Creates a managed checkout without exposing partial Git or identity state.
 *
 * Each clone attempt uses a unique StarSync-owned sibling directory. The
 * checkout is published with a same-filesystem rename only after its origin,
 * object database, archive scope, and stable identity have all been validated.
 */
export const createStagedCheckout = async (
	repository: StagedCheckoutRepository,
	targetBase: string,
	options: StagedCheckoutOptions
): Promise<void> => {
	assertRepositoryRequest(repository);
	const destinationPath = path.join(targetBase, repository.folderName);
	assertArchiveOwner(targetBase, options.archiveOwnerId);
	assertDestinationAvailable(destinationPath, repository.folderName);
	const stagingPath = await cloneValidatedCheckout(repository, targetBase, options);
	try {
		assertArchiveOwner(targetBase, options.archiveOwnerId);
		assertDestinationAvailable(destinationPath, repository.folderName);
		fs.renameSync(stagingPath, destinationPath);
	} catch (err) {
		const cleanupError = tryRemoveOwnedStagingDirectory(targetBase, stagingPath);
		if (cleanupError !== null) {
			throw new Error(
				`${sanitizeMessage(errorMessage(err))} StarSync could not remove its staging directory: ${sanitizeMessage(
					errorMessage(cleanupError)
				)}`,
				{ cause: err }
			);
		}
		throw err;
	}
};

/**
 * Replaces an anomalous managed checkout only after its fresh clone is fully validated.
 *
 * The original directory is moved aside on the same filesystem immediately before publication.
 * A failed publication rolls it back; a successful publication then removes the old directory.
 */
export const replaceAnomalousCheckout = async (
	repository: StagedCheckoutRepository,
	targetBase: string,
	options: StagedCheckoutOptions
): Promise<ReplacedCheckout> => {
	assertRepositoryRequest(repository);
	const destinationPath = path.join(targetBase, repository.folderName);
	if (!fs.existsSync(path.join(destinationPath, '.git'))) {
		throw new Error(`Anomalous checkout ${repository.folderName} is no longer present.`);
	}
	const stagingPath = await cloneValidatedCheckout(repository, targetBase, options);
	const backupPath = path.join(targetBase, `${DAMAGED_CHECKOUT_PREFIX}${randomUUID()}`);
	try {
		assertArchiveOwner(targetBase, options.archiveOwnerId);
		fs.renameSync(destinationPath, backupPath);
		try {
			assertDestinationAvailable(destinationPath, repository.folderName);
			fs.renameSync(stagingPath, destinationPath);
		} catch (err) {
			fs.renameSync(backupPath, destinationPath);
			throw err;
		}
	} catch (err) {
		const cleanupError = tryRemoveOwnedStagingDirectory(targetBase, stagingPath);
		const cleanupMessage =
			cleanupError === null
				? ''
				: ` StarSync could not remove its staging directory: ${sanitizeMessage(
						errorMessage(cleanupError)
					)}`;
		throw new Error(`${sanitizeMessage(errorMessage(err))}${cleanupMessage}`, { cause: err });
	}

	try {
		fs.rmSync(backupPath, { force: true, recursive: true });
		return { cleanupWarning: null };
	} catch (err) {
		return {
			cleanupWarning: `Fresh checkout was published, but the replaced directory remains at ${path.basename(
				backupPath
			)}: ${sanitizeMessage(errorMessage(err))}`,
		};
	}
};
