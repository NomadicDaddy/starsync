/**
 * The tag a write is made from. Split out of lock-write.ts, which writes the lock that names it.
 *
 * A TAG, because a lock that names a version has to name something that can be found again. A write
 * is made only while the owner's HEAD is exactly the annotated tag `v<package.json version>` and no
 * tracked file is modified or staged. The bytes themselves are not read from this guarantee but from
 * the tag commit (taggedBatches), so a file that differs from its blob without git reporting it
 * modified still delivers the tagged bytes; the refusals here keep the working tree an honest
 * witness rather than the source of what ships.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
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
 * The bytes every `paths` entry holds at `commit`, in one spawn. The write reads every delivered
 * source through this, so what lands in a target is what the tag holds by construction: a
 * working-tree file that differs from its blob without git reporting it modified — skip-worktree
 * is the known way — cannot leak disk bytes into a delivery. A write delivers many files, and a
 * git spawn per file costs more than the read itself on Windows; cat-file --batch answers the whole
 * report from one process. A path git cannot produce maps to null — the same refusal a single
 * missing read would raise — and a batch that fails outright yields an empty map, which blocks
 * every path it was asked for rather than letting any write fall back to disk.
 */
export function taggedBatches(
	root: string,
	commit: string,
	paths: string[],
): Map<string, null | string> {
	const results = new Map<string, null | string>();
	if (paths.length === 0) return results;
	const request = paths.map((path) => `${commit}:${path}\n`).join('');
	// The request is fed through input rather than a pipe fd: spawnSync with an input buffer is the
	// one form that cannot deadlock on a large batch answer.
	const fed = Bun.spawnSync(['git', '-C', root, 'cat-file', '--batch'], {
		stderr: 'pipe',
		stdin: new TextEncoder().encode(request),
		stdout: 'pipe',
		windowsHide: true,
	});
	if (fed.exitCode !== 0) {
		for (const path of paths) results.set(path, null);
		return results;
	}
	// The answer is parsed as BYTES, not a string: a blob's declared size counts bytes, and the
	// em-dashes these files contain make string indices diverge from byte offsets. Each blob is
	// decoded on its own once its byte extent is known.
	const answer = new Uint8Array(fed.stdout);
	// ignoreBOM keeps a leading byte-order mark in the blob: git show would deliver it, so the
	// batch must too, byte for byte - a stripped BOM would drift a BOM-carrying source silently.
	const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
	let offset = 0;
	let failed = false;
	for (const path of paths) {
		// Once one header is malformed the stream extent is unknown: every remaining path fails
		// closed rather than delivering a guess parsed off a mis-anchored offset.
		if (failed) {
			results.set(path, null);
			continue;
		}
		const newline = answer.indexOf(10, offset);
		if (newline === -1) {
			results.set(path, null);
			continue;
		}
		const header = decoder.decode(answer.subarray(offset, newline));
		offset = newline + 1;
		if (header.endsWith(' missing')) {
			results.set(path, null);
			continue;
		}
		const size = Number.parseInt(header.split(' ')[2] ?? '-1', 10);
		if (Number.isNaN(size) || size < 0 || offset + size > answer.length) {
			results.set(path, null);
			failed = true;
			continue;
		}
		// cat-file terminates every blob with a trailing newline that is not part of it.
		results.set(path, decoder.decode(answer.subarray(offset, offset + size)));
		offset += size + 1;
	}
	return results;
}

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
