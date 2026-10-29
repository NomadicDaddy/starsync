/**
 * The tag a write is made from. Split out of lock-write.ts, which writes the lock that names it.
 *
 * A TAG, because a lock that names a version has to name something that can be found again. A write
 * is made only while the owner's HEAD is exactly the annotated tag `v<package.json version>` and no
 * tracked file is modified or staged, so the bytes delivered are the bytes that commit holds.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The tag a write is made from: the owner's version and the commit its tag names. */
export interface Delivery {
	commit: string;
	version: string;
}

function rawGit(root: string, ...args: string[]): null | string {
	const result = Bun.spawnSync(['git', '-C', root, ...args], {
		stderr: 'pipe',
		stdout: 'pipe',
		windowsHide: true,
	});
	return result.exitCode === 0 ? result.stdout.toString() : null;
}

const git = (root: string, ...args: string[]): null | string =>
	rawGit(root, ...args)?.trim() ?? null;

/**
 * Tracked paths whose index or working copy differs from HEAD, sorted, or null when git cannot say.
 * The index is asked too: a change staged and then undone on disk leaves the working copy equal to
 * HEAD. Read raw, since trimming would cut a name's own leading space.
 */
function modifiedOrStaged(root: string): null | string[] {
	const unstaged = rawGit(root, 'diff', '--name-only', '-z', 'HEAD');
	const staged = rawGit(root, 'diff', '--cached', '--name-only', '-z', 'HEAD');
	if (unstaged === null || staged === null) return null;
	const paths = `${unstaged}${staged}`.split('\0').filter((path) => path !== '');
	return [...new Set(paths)].sort();
}

/** The delivery a write from `root` would name, or the reason it may not be made from here. */
export function tagStanding(root: string): { delivery: Delivery } | { refusal: string } {
	let version: unknown;
	try {
		const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as unknown;
		version = (manifest as { version?: unknown } | null)?.version;
	} catch {
		version = undefined;
	}
	if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)) {
		return { refusal: `package.json in ${root} states no version of the form 1.2.3` };
	}
	const tag = `v${version}`;
	const kind = git(root, 'cat-file', '-t', `refs/tags/${tag}`);
	if (kind === null)
		return { refusal: `there is no tag ${tag} for the version package.json states` };
	// A lightweight tag is a second name for a commit and nothing more: it records no tagger and
	// no date, and moving it leaves no trace.
	if (kind !== 'tag') return { refusal: `${tag} is not an annotated tag` };

	const named = git(root, 'rev-parse', `${tag}^{commit}`);
	const head = git(root, 'rev-parse', 'HEAD');
	if (named === null || head === null) return { refusal: `git could not resolve ${tag} or HEAD` };
	if (named !== head) return { refusal: `HEAD is not the commit ${tag} names` };

	const paths = modifiedOrStaged(root);
	if (paths === null) return { refusal: 'git could not report the state of the working tree' };
	if (paths.length > 0) {
		return {
			refusal: `${paths.length} tracked file(s) are modified or staged, so HEAD is not what is here: ${paths.join(', ')}`,
		};
	}
	return { delivery: { commit: head, version } };
}
