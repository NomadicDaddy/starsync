import type { ArchiveEntry, RepositoryResolver, ResolvedRepository } from './archive-migration.ts';
import type { VerifiedCheckout } from './archive-verification-checkout.ts';
import type { ReplacedCheckout, StagedCheckoutRepository } from './staged-checkout.ts';

import { canonicalCheckoutName } from './checkout-identity.ts';
import { sanitizeMessage } from './secret-safety.ts';
import { replaceAnomalousCheckout } from './staged-checkout.ts';

export type CheckoutReplacer = (
	repository: StagedCheckoutRepository,
	targetBase: string,
	options: { archiveOwnerId: number }
) => Promise<ReplacedCheckout>;

export interface ArchiveVerificationRepairOptions {
	archiveOwnerId: number;
	replaceCheckout?: CheckoutReplacer;
	resolveRepository: RepositoryResolver;
	targetPath: string;
}

export type CheckoutRepairResult =
	| {
			cleanupWarning: null;
			ok: false;
			reason: string;
			repository: null;
	  }
	| {
			cleanupWarning: null | string;
			ok: true;
			reason: null;
			repository: ResolvedRepository;
	  };

const candidateSlugs = (folderName: string): string[] => {
	const candidates: string[] = [];
	for (
		let index = folderName.indexOf('--');
		index >= 0;
		index = folderName.indexOf('--', index + 2)
	) {
		const repository = folderName.slice(0, index);
		const owner = folderName.slice(index + 2);
		const slug = `${owner}/${repository}`;
		if (canonicalCheckoutName(slug)?.toLowerCase() === folderName.toLowerCase()) {
			candidates.push(slug);
		}
	}
	return candidates;
};

const resolveCandidate = async (
	slug: string,
	resolveRepository: RepositoryResolver
): Promise<null | ResolvedRepository> => {
	const [owner, repository] = slug.split('/');
	if (!owner || !repository) return null;
	try {
		const resolved = await resolveRepository(owner, repository);
		return canonicalCheckoutName(resolved.slug)?.toLowerCase() ===
			canonicalCheckoutName(slug)?.toLowerCase()
			? resolved
			: null;
	} catch {
		return null;
	}
};

const resolveDamagedRepository = async (
	entry: ArchiveEntry,
	verified: VerifiedCheckout,
	resolveRepository: RepositoryResolver
): Promise<ResolvedRepository> => {
	const slugs = [
		...(verified.repositorySlug === null ? [] : [verified.repositorySlug]),
		...candidateSlugs(entry.name),
	];
	const resolved = new Map<number, ResolvedRepository>();
	for (const slug of new Set(slugs.map((value) => value.toLowerCase()))) {
		const repository = await resolveCandidate(slug, resolveRepository);
		if (
			repository !== null &&
			canonicalCheckoutName(repository.slug)?.toLowerCase() === entry.name.toLowerCase() &&
			(verified.repositoryId === null || verified.repositoryId === repository.id)
		) {
			resolved.set(repository.id, repository);
		}
	}
	if (resolved.size === 0) {
		throw new Error(
			`Cannot resolve ${entry.name} to one canonical GitHub repository; the anomalous checkout was not removed.`
		);
	}
	if (resolved.size > 1) {
		throw new Error(
			`More than one GitHub repository matches ${entry.name}; the anomalous checkout was not removed.`
		);
	}
	return [...resolved.values()][0]!;
};

export const repairAnomalousCheckout = async (
	entry: ArchiveEntry,
	verified: VerifiedCheckout,
	options: ArchiveVerificationRepairOptions
): Promise<CheckoutRepairResult> => {
	try {
		const repository = await resolveDamagedRepository(
			entry,
			verified,
			options.resolveRepository
		);
		const replacement = await (options.replaceCheckout ?? replaceAnomalousCheckout)(
			{
				cloneUrl: `https://github.com/${repository.slug}.git`,
				folderName: entry.name,
				repositoryId: repository.id,
				repositorySlug: repository.slug,
			},
			options.targetPath,
			{ archiveOwnerId: options.archiveOwnerId }
		);
		return {
			cleanupWarning: replacement.cleanupWarning,
			ok: true,
			reason: null,
			repository,
		};
	} catch (err) {
		return {
			cleanupWarning: null,
			ok: false,
			reason: sanitizeMessage(err instanceof Error ? err.message : String(err)),
			repository: null,
		};
	}
};
