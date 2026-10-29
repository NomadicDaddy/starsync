/**
 * Path-shaped words in a consumer's own file that name a moved path in ways `pathPattern` cannot
 * see: relative to the file (a Markdown link from docs/), rooted at the repository, written with
 * Windows backslashes, or as a glob.
 *
 * A glob counts only when it holds a `/` and matches the old path but not the new one. One without
 * a `/`, as in an ignore file, matches at any depth and so still covers the moved file; `**` and
 * `*.ts` globs keep covering it too. `scripts/check-*.ts` stops covering it, so that one is listed.
 */
import { posix } from 'node:path';

/** A run of characters a path, glob or link target can hold. Quotes, spaces and parentheses end it. */
const WORD = /[^\s'"`()<>;|=]+/g;

/** Characters that make a word a glob. */
const GLOB = /[*?{]/;

/**
 * The word as a forward-slash path, without a link's `#fragment`, a `?query` after a file's
 * extension, a trailing `:line`, or sentence punctuation. A `?` anywhere else stays: in a glob it
 * matches one character, as in `check-?.ts`.
 */
function cleaned(word: string): string {
	return word
		.replace(/\\+/g, '/')
		.replace(/#.*$/, '')
		.replace(/(\.[A-Za-z0-9]+)\?[^/]*$/, '$1')
		.replace(/:\d+(?::\d+)?$/, '')
		.replace(/[.,:]+$/, '');
}

/** The repository paths a cleaned word can mean, read from the file at `file`. */
function readings(file: string, path: string): string[] {
	if (path.startsWith('/')) return [posix.normalize(path.slice(1))];
	const all = [posix.normalize(path), posix.normalize(posix.join(posix.dirname(file), path))];
	return [...new Set(all)].filter((reading) => !reading.startsWith('../'));
}

/** The moved paths, file or whole folder, that a plain word names. */
function namedPaths(candidates: readonly string[], names: ReadonlyMap<string, string>): string[] {
	const found = new Set<string>();
	for (const reading of candidates) {
		if (names.has(reading)) found.add(reading);
		else if (names.has(`${reading}/`)) found.add(`${reading}/`);
	}
	return [...found];
}

/**
 * Whether a reading can be a path glob. It must still hold a `/` once read, so a comment opener
 * (`/*`) or a regex fragment (`\s*`) does not become the glob `*`, and it must hold no `[`, which
 * here is a Markdown link far more often than a class. A leading wildcard is allowed: `*\/check-a.ts`
 * and `{scripts,tools}/check-*.ts` can stop covering a moved file too (Morticia, L-5 on 3630ef9).
 * But it must name something: at least one name character. `*\/*` in an Accept header, or a regex's
 * escaped `\*` read as `/*\/*`, matches any two-segment path and names none of them, while
 * `*\/*.ts` and `*\/a.ts` name an extension or a file and stop covering it one folder deeper
 * (Roger M-1 and Morticia M-3 on 5ee3755).
 */
function isPathGlob(reading: string): boolean {
	return reading.includes('/') && !/[[\]]/.test(reading) && /\w/.test(reading);
}

/** The glob's segments before its first wildcard, as a folder with a trailing slash. */
function literalFolder(reading: string): string {
	const segments = reading.split('/');
	const first = segments.findIndex((segment) => /[*?{]/.test(segment));
	return `${segments.slice(0, first).join('/')}/`;
}

/**
 * The moved files a glob covers before the move and no longer covers after it. A glob over a
 * folder that moved whole is one reference to that folder, not one per file inside it.
 */
function globbedPaths(candidates: readonly string[], names: ReadonlyMap<string, string>): string[] {
	const found = new Set<string>();
	for (const reading of candidates.filter(isPathGlob)) {
		let glob: Bun.Glob;
		try {
			glob = new Bun.Glob(reading);
		} catch {
			continue;
		}
		const matched = [...names].filter(
			([from, to]) => !from.endsWith('/') && glob.match(from) && !glob.match(to),
		);
		if (matched.length === 0) continue;
		const folder = literalFolder(reading);
		if (names.has(folder) && matched.every(([from]) => from.startsWith(folder)))
			found.add(folder);
		else for (const [from] of matched) found.add(from);
	}
	return [...found];
}

/**
 * Each moved path a path-shaped word in `text` names, with the word's offset.
 *
 * @param file - The file's repository path, which relative words are read from.
 * @param text - Its contents.
 * @param names - Each moved path, folders with a trailing slash, with where it now lives.
 */
export function pathWordMentions(
	file: string,
	text: string,
	names: ReadonlyMap<string, string>,
): { from: string; index: number }[] {
	const mentions: { from: string; index: number }[] = [];
	for (const match of text.matchAll(WORD)) {
		const path = cleaned(match[0]);
		if (!path.includes('/') || path.includes('://')) continue;
		const candidates = readings(file, path);
		const paths = GLOB.test(path)
			? globbedPaths(candidates, names)
			: namedPaths(candidates, names);
		for (const from of paths) mentions.push({ from, index: match.index });
	}
	return mentions;
}
