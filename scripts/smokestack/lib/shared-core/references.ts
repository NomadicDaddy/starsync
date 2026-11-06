/**
 * A consumer's own files that name a path a delivery moved.
 *
 * The write moves delivered files and rewrites package.json scripts, but a consumer's own imports,
 * configs and documents are its lead's to change in the delivery commit (old-path.ts). Nothing used
 * to say which ones: spernakit's first v0.6.0 delivery left eleven imports pointing at moved
 * modules, and seven escaped regular expressions in its init exclusions naming them, and only its
 * own typecheck and a later review found them. So the write lists every reference, in every
 * spelling, for the lead to change, and the check fails on a relative import that resolves to an
 * old path, because that one cannot typecheck.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { existsSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

import { pathPattern } from './move-scripts.ts';
import { pathWordMentions } from './path-words.ts';
import { looksBinary, MAX_BYTES, readText } from './read-text.ts';

/** Where everything smokestack delivers lives in a consumer; nothing there is the consumer's own. */
const DELIVERED_HOME = 'scripts/smokestack/';

/** File types that hold relative module imports. */
const CODE = /\.(?:[cm]?[jt]sx?)$/;

/** A relative module specifier in an import, an export-from, a dynamic import or a require. */
const SPECIFIER =
	/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(['"])(\.{1,2}\/[^'"]+)\1/gm;

export interface Reference {
	file: string;
	from: string;
	/** `import` resolves to the old path and cannot typecheck; `mention` names it some other way. */
	kind: 'import' | 'mention';
	line: number;
	to: string;
}

/**
 * The ways a regular expression spells `path`: a literal escapes every `.` and often every `/`, and
 * a string passed to `new RegExp` carries each escape as a doubled backslash in the source. Plain
 * spellings are left to `pathPattern`.
 */
function escapedSpellings(path: string): string[] {
	const spellings = [/[./]/g, /\./g].flatMap((which) => {
		const single = path.replace(which, (char) => `\\${char}`);
		return [single, single.replaceAll('\\', '\\\\')];
	});
	return [...new Set(spellings)].filter((spelling) => spelling !== path);
}

/** Script extensions a specifier may leave off. */
const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** The TypeScript files a compiled-form specifier names, as TypeScript resolves `x.js` to `x.ts`. */
const COMPILED_SOURCES: Record<string, string[]> = {
	'.cjs': ['.cts'],
	'.js': ['.ts', '.tsx'],
	'.mjs': ['.mts'],
};

/**
 * Every file a relative specifier can resolve to: as written, with an extension added, the
 * TypeScript source of a `.js` spelling, or a folder's index. spernakit's own imports name the `.ts`
 * file, but an extensionless or `.js` import of a moved module fails to typecheck just the same.
 */
function resolutions(target: string): string[] {
	const extension = posix.extname(target);
	const base = target.slice(0, target.length - extension.length);
	return [
		target,
		...SCRIPT_EXTENSIONS.map((added) => `${target}${added}`),
		...SCRIPT_EXTENSIONS.map((added) => `${target}/index${added}`),
		...(COMPILED_SOURCES[extension] ?? []).map((source) => `${base}${source}`),
	];
}

/** The moved file a specifier resolves to, if any. */
function movedTarget(target: string, moved: ReadonlyMap<string, string>): string | undefined {
	return resolutions(target).find((candidate) => moved.has(candidate));
}

/** The repository's tracked files, or why git could not list them. */
function listTracked(root: string): { error?: string; files: string[] } {
	const result = Bun.spawnSync(['git', '-C', root, 'ls-files', '-z'], {
		stderr: 'pipe',
		stdout: 'pipe',
		windowsHide: true,
	});
	if (result.exitCode !== 0) {
		const reason =
			result.stderr.toString().trim().split('\n')[0] || `exit ${String(result.exitCode)}`;
		return { error: reason, files: [] };
	}
	return { files: result.stdout.toString().split('\0').filter(Boolean) };
}

/** The repository's tracked files; `unreadFiles` reports when this list is empty because git failed. */
function trackedFiles(root: string): string[] {
	return listTracked(root).files;
}

/**
 * The consumer's own tracked files this sweep could not read, each with the reason. Clause 7 lets
 * nothing go unseen, so the write refuses and the check fails while any remain: git could not list
 * the files at all, or a text file is over the size this reads.
 */
export function unreadFiles(root: string): string[] {
	const listing = listTracked(root);
	if (listing.error !== undefined) {
		return [`git could not list its tracked files (${listing.error}), so none were read`];
	}
	return listing.files
		.filter((file) => !file.startsWith(DELIVERED_HOME))
		.filter((file) => {
			const at = join(root, file);
			return existsSync(at) && statSync(at).size > MAX_BYTES && !looksBinary(at);
		})
		.map((file) => `${file} is text over ${String(MAX_BYTES / 1_000_000)} MB and was not read`);
}

/** The 1-based line `index` falls on, given the offset of every newline in the text. */
function lineOf(newlines: readonly number[], index: number): number {
	let low = 0;
	let high = newlines.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if ((newlines[mid] ?? 0) < index) low = mid + 1;
		else high = mid;
	}
	return low + 1;
}

/** The offset of every newline in `text`. */
function newlineOffsets(text: string): number[] {
	const offsets: number[] = [];
	for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) offsets.push(at);
	return offsets;
}

/**
 * Each moved file, plus each folder that moves whole, written with a trailing slash: a consumer can
 * name the folder rather than the file, as an init exclusion does. A folder moves whole when every
 * tracked file in it moves, all to one new folder; one that keeps other files has not moved.
 */
function movedNames(
	moved: ReadonlyMap<string, string>,
	tracked: readonly string[],
): Map<string, string> {
	const names = new Map(moved);
	const folders = new Map<string, Set<string>>();
	for (const [from, to] of moved) {
		const fromDir = posix.dirname(from);
		if (fromDir === '.') continue;
		const toDirs = folders.get(fromDir) ?? new Set<string>();
		toDirs.add(posix.dirname(to));
		folders.set(fromDir, toDirs);
	}
	for (const [fromDir, toDirs] of folders) {
		const [toDir] = toDirs;
		if (toDirs.size !== 1 || toDir === undefined || toDir === fromDir) continue;
		const stays = tracked.some((file) => file.startsWith(`${fromDir}/`) && !moved.has(file));
		if (!stays) names.set(`${fromDir}/`, `${toDir}/`);
	}
	return names;
}

/** The part of a path's last segment before any dot, which every spelling of the path contains. */
function stem(path: string): string {
	const segment = posix.basename(path);
	return segment.split('.')[0] || segment;
}

/**
 * Every place one of the consumer's own tracked files names a moved path.
 *
 * @param root - The consumer's checkout.
 * @param moved - Each old path, with the path this release installs it at.
 * @returns One reference per file, line and old path, imports first within a file.
 */
export function referencesTo(root: string, moved: ReadonlyMap<string, string>): Reference[] {
	if (moved.size === 0) return [];
	const delivered = new Set(moved.values());
	const tracked = trackedFiles(root);
	const names = movedNames(moved, tracked);
	const references: Reference[] = [];
	for (const file of tracked) {
		if (file.startsWith(DELIVERED_HOME) || delivered.has(file) || moved.has(file)) continue;
		const text = readText(join(root, file));
		if (text === null) continue;
		const newlines = newlineOffsets(text);
		const seen = new Set<string>();
		const add = (kind: Reference['kind'], from: string, index: number): void => {
			const line = lineOf(newlines, index);
			const key = `${String(line)}\0${from}`;
			if (seen.has(key)) return;
			seen.add(key);
			references.push({ file, from, kind, line, to: names.get(from) ?? from });
		};
		for (const imported of importsIn(file, text)) {
			const target = movedTarget(imported.target, moved);
			if (target !== undefined) add('import', target, imported.index);
		}
		for (const from of names.keys()) {
			// Every spelling contains the last segment, so a file without it cannot name the path.
			if (!text.includes(stem(from))) continue;
			for (const match of text.matchAll(pathPattern(from))) add('mention', from, match.index);
			for (const spelling of escapedSpellings(from)) {
				for (
					let at = text.indexOf(spelling);
					at >= 0;
					at = text.indexOf(spelling, at + 1)
				) {
					add('mention', from, at);
				}
			}
		}
		for (const mention of pathWordMentions(file, text, names)) {
			add('mention', mention.from, mention.index);
		}
	}
	return references;
}

/** Each relative module specifier in a code file, resolved against the file's folder. */
function importsIn(file: string, text: string): { index: number; target: string }[] {
	if (!CODE.test(file)) return [];
	return [...text.matchAll(SPECIFIER)].map((match) => ({
		index: match.index,
		target: posix.normalize(posix.join(posix.dirname(file), match[2] ?? '')),
	}));
}

/**
 * Every relative import in the consumer's own code, read once per checkout: the check asks for
 * each group of each target, and a checkout's code does not change while one sweep runs.
 */
function ownImports(root: string): { file: string; line: number; target: string }[] {
	const known = importsOf.get(root);
	if (known !== undefined) return known;
	const imports = trackedFiles(root)
		.filter((file) => CODE.test(file) && !file.startsWith(DELIVERED_HOME))
		.flatMap((file) => {
			const text = readText(join(root, file));
			if (text === null) return [];
			const newlines = newlineOffsets(text);
			return importsIn(file, text).map((imported) => ({
				file,
				line: lineOf(newlines, imported.index),
				target: imported.target,
			}));
		});
	importsOf.set(root, imports);
	return imports;
}

const importsOf = new Map<string, { file: string; line: number; target: string }[]>();

/** Relative imports in the consumer's own code that resolve to an old path no longer on disk. */
export function brokenImports(root: string, moved: ReadonlyMap<string, string>): Reference[] {
	return ownImports(root).flatMap((imported): Reference[] => {
		const from = movedTarget(imported.target, moved);
		if (from === undefined || existsSync(join(root, from))) return [];
		const to = moved.get(from) ?? from;
		return [{ file: imported.file, from, kind: 'import', line: imported.line, to }];
	});
}

/** One line of the write's report for each reference, worded for the lead who changes it. */
export function referenceLines(directory: string, references: readonly Reference[]): string[] {
	return references.map(
		(reference) =>
			`LEAD ${directory}: ${reference.file}:${String(reference.line)} ` +
			`${reference.kind === 'import' ? 'imports' : 'names'} ${reference.from} (now ${reference.to})`,
	);
}
