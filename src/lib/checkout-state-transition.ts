import type { CheckoutIdentity } from './checkout-identity.ts';
import type { GitExecOptions } from './git-exec.ts';

import {
	canonicalCheckoutName,
	REPOSITORY_ID_KEY,
	REPOSITORY_SLUG_KEY,
} from './checkout-identity.ts';
import { runGit } from './git-exec.ts';

export type CheckoutStateRunner = (args: string[], options: GitExecOptions) => Promise<string>;

interface CheckoutState {
	identity: CheckoutIdentity;
	origin: string;
}

interface StateMutation {
	args: string[];
	label: string;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const readCheckoutState = async (
	checkoutPath: string,
	runner: CheckoutStateRunner,
): Promise<CheckoutState> => {
	const [origin, rawId, repositorySlug] = await Promise.all([
		runner(['config', '--local', '--get', 'remote.origin.url'], { cwd: checkoutPath }),
		runner(['config', '--local', '--get', REPOSITORY_ID_KEY], { cwd: checkoutPath }),
		runner(['config', '--local', '--get', REPOSITORY_SLUG_KEY], { cwd: checkoutPath }),
	]);
	const repositoryId = Number(rawId);
	if (
		!Number.isSafeInteger(repositoryId) ||
		repositoryId <= 0 ||
		canonicalCheckoutName(repositorySlug) === null
	) {
		throw new Error('Cannot transition invalid checkout identity metadata.');
	}
	return { identity: { repositoryId, repositorySlug }, origin };
};

const stateMatches = (actual: CheckoutState, expected: CheckoutState): boolean =>
	actual.origin === expected.origin &&
	actual.identity.repositoryId === expected.identity.repositoryId &&
	actual.identity.repositorySlug === expected.identity.repositorySlug;

const mutationsForState = (state: CheckoutState): StateMutation[] => [
	{
		args: ['remote', 'set-url', 'origin', state.origin],
		label: 'origin',
	},
	{
		args: ['config', '--local', REPOSITORY_ID_KEY, String(state.identity.repositoryId)],
		label: 'repository ID',
	},
	{
		args: ['config', '--local', REPOSITORY_SLUG_KEY, state.identity.repositorySlug],
		label: 'repository slug',
	},
];

const writeCheckoutState = async (
	checkoutPath: string,
	state: CheckoutState,
	runner: CheckoutStateRunner,
): Promise<void> => {
	for (const mutation of mutationsForState(state)) {
		await runner(mutation.args, { cwd: checkoutPath });
	}
};

const restoreCheckoutState = async (
	checkoutPath: string,
	snapshot: CheckoutState,
	runner: CheckoutStateRunner,
): Promise<string[]> => {
	const failures: string[] = [];
	for (const mutation of mutationsForState(snapshot)) {
		try {
			await runner(mutation.args, { cwd: checkoutPath });
		} catch (err) {
			failures.push(`${mutation.label}: ${errorMessage(err)}`);
		}
	}
	try {
		const restored = await readCheckoutState(checkoutPath, runner);
		if (!stateMatches(restored, snapshot)) failures.push('snapshot verification failed');
	} catch (err) {
		failures.push(`snapshot verification: ${errorMessage(err)}`);
	}
	return failures;
};

const desiredCheckoutState = (identity: CheckoutIdentity): CheckoutState => {
	if (
		!Number.isSafeInteger(identity.repositoryId) ||
		identity.repositoryId <= 0 ||
		canonicalCheckoutName(identity.repositorySlug) === null
	) {
		throw new Error('Cannot transition to invalid checkout identity metadata.');
	}
	return {
		identity,
		origin: `https://github.com/${identity.repositorySlug}.git`,
	};
};

export const transitionCheckoutState = async (
	checkoutPath: string,
	identity: CheckoutIdentity,
	runner: CheckoutStateRunner = runGit,
): Promise<void> => {
	const desired = desiredCheckoutState(identity);
	const snapshot = await readCheckoutState(checkoutPath, runner);
	if (snapshot.identity.repositoryId !== desired.identity.repositoryId) {
		throw new Error('Cannot change a managed checkout stable repository identity.');
	}
	try {
		await writeCheckoutState(checkoutPath, desired, runner);
		const updated = await readCheckoutState(checkoutPath, runner);
		if (!stateMatches(updated, desired)) {
			throw new Error('Checkout state verification failed after mutation.');
		}
	} catch (err) {
		const rollbackFailures = await restoreCheckoutState(checkoutPath, snapshot, runner);
		if (rollbackFailures.length > 0) {
			throw new Error(
				`${errorMessage(err)} Rollback also failed: ${rollbackFailures.join('; ')}.`,
				{ cause: err },
			);
		}
		throw err;
	}
};

export const finalizeCheckoutIdentity = async (
	checkoutPath: string,
	identity: CheckoutIdentity,
): Promise<Error | null> => {
	try {
		await transitionCheckoutState(checkoutPath, identity);
		return null;
	} catch (err) {
		return new Error(
			`Repository refreshed, but managed checkout metadata could not be finalized: ${errorMessage(err)}`,
		);
	}
};
