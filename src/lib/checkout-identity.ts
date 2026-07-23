import { runGit } from './git-exec.ts';

export const REPOSITORY_ID_KEY = 'starsync.repository-id';
export const REPOSITORY_SLUG_KEY = 'starsync.repository-slug';

export interface CheckoutIdentity {
	repositoryId: number;
	repositorySlug: string;
}

interface GitCommandError {
	code?: number | string;
	stderr?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const gitErrorDetails = (err: unknown): GitCommandError => {
	if (!isRecord(err)) return {};
	const details: GitCommandError = {};
	if (typeof err.code === 'number' || typeof err.code === 'string') details.code = err.code;
	if (typeof err.stderr === 'string') details.stderr = err.stderr;
	return details;
};

const readOptionalLocalConfig = async (
	checkoutPath: string,
	key: string
): Promise<null | string> => {
	try {
		return await runGit(['config', '--local', '--get', key], { cwd: checkoutPath });
	} catch (err) {
		const details = gitErrorDetails(err);
		if (Number(details.code) === 1 && !details.stderr?.trim()) return null;
		throw err;
	}
};

export const canonicalCheckoutName = (slug: string): null | string => {
	const match = slug.match(/^([a-z\d](?:[a-z\d-]*[a-z\d])?)\/([a-z\d._-]+)$/i);
	return match?.[1] && match[2] ? `${match[2]}--${match[1]}` : null;
};

export const readCheckoutIdentity = async (
	checkoutPath: string
): Promise<CheckoutIdentity | null> => {
	const [rawId, rawSlug] = await Promise.all([
		readOptionalLocalConfig(checkoutPath, REPOSITORY_ID_KEY),
		readOptionalLocalConfig(checkoutPath, REPOSITORY_SLUG_KEY),
	]);
	if (rawId === null && rawSlug === null) return null;
	if (rawId === null || rawSlug === null) {
		throw new Error('Checkout identity metadata is incomplete.');
	}

	const repositoryId = Number(rawId);
	if (
		!Number.isSafeInteger(repositoryId) ||
		repositoryId <= 0 ||
		canonicalCheckoutName(rawSlug) === null
	) {
		throw new Error('Checkout identity metadata is invalid.');
	}
	return { repositoryId, repositorySlug: rawSlug };
};

export const writeCheckoutIdentity = async (
	checkoutPath: string,
	identity: CheckoutIdentity
): Promise<void> => {
	if (
		!Number.isSafeInteger(identity.repositoryId) ||
		identity.repositoryId <= 0 ||
		canonicalCheckoutName(identity.repositorySlug) === null
	) {
		throw new Error('Cannot write invalid checkout identity metadata.');
	}
	await runGit(['config', '--local', REPOSITORY_ID_KEY, String(identity.repositoryId)], {
		cwd: checkoutPath,
	});
	await runGit(['config', '--local', REPOSITORY_SLUG_KEY, identity.repositorySlug], {
		cwd: checkoutPath,
	});
};

export const updateCheckoutOrigin = async (
	checkoutPath: string,
	repositorySlug: string
): Promise<void> => {
	if (canonicalCheckoutName(repositorySlug) === null) {
		throw new Error('Cannot update an origin from an invalid repository slug.');
	}
	await runGit(['remote', 'set-url', 'origin', `https://github.com/${repositorySlug}.git`], {
		cwd: checkoutPath,
	});
};

export const finalizeCheckoutIdentity = async (
	checkoutPath: string,
	identity: CheckoutIdentity
): Promise<Error | null> => {
	try {
		await updateCheckoutOrigin(checkoutPath, identity.repositorySlug);
		await writeCheckoutIdentity(checkoutPath, identity);
		return null;
	} catch (err) {
		return new Error(
			`Repository refreshed, but managed checkout metadata could not be finalized: ${
				err instanceof Error ? err.message : String(err)
			}`
		);
	}
};
