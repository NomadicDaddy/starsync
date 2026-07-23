import fs from 'node:fs';
import path from 'node:path';

import { readArchiveConfig } from './archive-config.ts';
import {
	canonicalCheckoutName,
	readCheckoutIdentity,
	writeCheckoutIdentity,
} from './checkout-identity.ts';
import { isTransientGitError, runGit } from './git-exec.ts';
import {
	hasEmbeddedCredentials,
	isGitHubDotComUrl,
	sanitizeMessage,
	sanitizeUrl,
} from './secret-safety.ts';

export const STAGED_CHECKOUT_PREFIX = '.starsync-checkout-';

export interface StagedCheckoutRepository {
	cloneUrl: string;
	folderName: string;
	repositoryId: number;
	repositorySlug: string;
}

export interface StagedCheckoutOptions {
	archiveOwnerId: number;
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
		!path.basename(resolvedStaging).startsWith(STAGED_CHECKOUT_PREFIX)
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

	for (let attempt = 0; attempt < 2; attempt++) {
		assertArchiveOwner(targetBase, options.archiveOwnerId);
		assertDestinationAvailable(destinationPath, repository.folderName);

		const stagingPath = fs.mkdtempSync(path.join(targetBase, STAGED_CHECKOUT_PREFIX));
		try {
			await runGit(['clone', repository.cloneUrl, path.basename(stagingPath)], {
				cwd: targetBase,
			});
			await validateStagedCheckout(stagingPath, repository);
			assertArchiveOwner(targetBase, options.archiveOwnerId);
			assertDestinationAvailable(destinationPath, repository.folderName);
			fs.renameSync(stagingPath, destinationPath);
			return;
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
};
