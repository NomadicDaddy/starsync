import { isTransientGitError, runGit } from './git-exec.ts';
import { sanitizeMessage } from './secret-safety.ts';

const REJECTED_REF = /^\s*!\s+\[rejected\]/;
const HARD_FAILURE = /^\s*(?:error|fatal):/;
const TAG_CLOBBER =
	/^\s*!\s+\[rejected\]\s+(\S+)\s+->\s+(\S+)\s+\(would clobber existing tag\)\s*$/;

const RETAINED_TAG_SAMPLE = 10;

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Returns the local tags a fetch refused to move, or null when the failure was
 * not confined to tag clobber rejections.
 *
 * Git exits non-zero when any reference update is rejected, even after every
 * branch has already been updated. An upstream tag that now points somewhere
 * else is the one rejection a refresh tolerates: preserving the archived tag
 * target matters more than tracking the move, so the fetch counts as done and
 * the remaining refresh proceeds.
 */
export const classifyTagClobberFailure = (message: string): null | string[] => {
	const lines = message.split(/\r?\n/);
	if (lines.some((line) => HARD_FAILURE.test(line))) return null;
	const rejections = lines.filter((line) => REJECTED_REF.test(line));
	if (rejections.length === 0) return null;
	const retained: string[] = [];
	for (const rejection of rejections) {
		const match = TAG_CLOBBER.exec(rejection);
		if (match === null) return null;
		const tag = match[2];
		if (tag !== undefined) retained.push(tag);
	}
	return retained.length === 0 ? null : retained;
};

/** Describes retained tags for a report without printing an unbounded list. */
export const describeRetainedTags = (tags: string[]): string => {
	const sample = tags.slice(0, RETAINED_TAG_SAMPLE);
	const remainder = tags.length - sample.length;
	const suffix = remainder > 0 ? `, and ${remainder} more` : '';
	const subject = tags.length === 1 ? 'tag' : 'tags';
	return (
		`Upstream moved ${tags.length} ${subject} that the archive already stores; ` +
		`the archived target was kept for ${sample.join(', ')}${suffix}.`
	);
};

const fetchOnce = async (repoPath: string): Promise<string[]> => {
	try {
		await runGit(['fetch', '--tags', '--no-prune', 'origin'], { cwd: repoPath });
		return [];
	} catch (err) {
		const retained = classifyTagClobberFailure(errorMessage(err));
		if (retained === null) throw err;
		return retained;
	}
};

/**
 * Fetches every remote branch and tag, retrying once on a transient transport
 * failure, and reports the tags whose archived target was kept.
 */
export const fetchRemoteRefs = async (repoPath: string): Promise<string[]> => {
	try {
		return await fetchOnce(repoPath);
	} catch (err) {
		if (!isTransientGitError(sanitizeMessage(errorMessage(err)))) throw err;
		await sleep(1000);
		return fetchOnce(repoPath);
	}
};
