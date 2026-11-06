/**
 * The repository files a step's code inputs import. A step whose declared input is a script runs
 * the helpers that script imports too, so they are keyed beside it; otherwise a change to a helper
 * alone would replay a pass recorded over the old one.
 *
 * Followed: static `import` and `export ... from`, type-only ones included, from every TypeScript
 * or JavaScript file given and from every file reached that way. A specifier is resolved as Bun
 * resolves it: extensions, index files, a `.js` naming a `.ts`, tsconfig paths. What resolves to a
 * file in the repository outside `node_modules` is kept; a package is keyed through `bun.lock` and
 * a built-in by the Bun version. A relative or absolute specifier that resolves to no file throws,
 * and the step, which cannot then be keyed, runs. A bare one that resolves to nothing is taken for
 * a package that is not installed.
 *
 * Not followed: dynamic `import()`, `require`, and files read at run time; a step declares those.
 * A file Bun cannot parse imports nothing, since it cannot run: a fixture that is broken on purpose
 * does not make a step that only reads it uncacheable.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

type Loader = 'js' | 'jsx' | 'ts' | 'tsx';

const LOADERS: Readonly<Record<string, Loader>> = {
	'.cjs': 'js',
	'.cts': 'ts',
	'.js': 'js',
	'.jsx': 'jsx',
	'.mjs': 'js',
	'.mts': 'ts',
	'.ts': 'ts',
	'.tsx': 'tsx',
};

/**
 * Bun's scanner drops type-only imports, as its transpiler does. Rewritten as value imports they
 * are kept. Text inside a string that looks like one is rewritten too, and stays a string.
 */
const TYPE_ONLY: readonly (readonly [RegExp, string])[] = [
	[/\bimport\s+type\s+(?=[{*]|[\w$]+\s+from\b)/gu, 'import '],
	[/\bexport\s+type\s+(?=[{*])/gu, 'export '],
	[/([{,]\s*)type\s+(?=[\w$]+\s*(?:[,}]|as\b))/gu, '$1'],
];

function loaderOf(path: string): Loader | null {
	const dot = path.lastIndexOf('.');
	return dot === -1 ? null : (LOADERS[path.slice(dot)] ?? null);
}

function staticImports(source: string, loader: Loader): string[] {
	return new Bun.Transpiler({ loader })
		.scanImports(source)
		.filter((item) => item.kind === 'import-statement')
		.map((item) => item.path);
}

/** The specifiers a file imports statically, type-only ones included. */
function specifiersOf(root: string, file: string, loader: Loader): string[] {
	const source = readFileSync(join(root, file), 'utf8');
	try {
		staticImports(source, loader);
	} catch {
		return [];
	}
	const rewritten = TYPE_ONLY.reduce((text, [pattern, by]) => text.replace(pattern, by), source);
	try {
		return staticImports(rewritten, loader);
	} catch {
		throw new Error(`the imports of ${file} cannot be read`);
	}
}

function isBare(specifier: string): boolean {
	return !specifier.startsWith('.') && !isAbsolute(specifier) && !specifier.startsWith('/');
}

/** Every repository file `files` reach through static imports, not counting `files` themselves. */
export function importedFiles(root: string, files: readonly string[]): string[] {
	// Bun answers with the real path; the root may be reached through a junction or a subst drive.
	const realRoot = realpathSync.native(root);
	const local = (resolved: string): null | string => {
		if (!isAbsolute(resolved)) return null; // a built-in: node:fs, bun:test
		const path = relative(realRoot, realpathSync.native(resolved)).split(sep).join('/');
		if (path === '..' || path.startsWith('../') || isAbsolute(path)) return null;
		return path.split('/').includes('node_modules') ? null : path;
	};
	const seen = new Set(files);
	const queue = [...files];
	const found: string[] = [];
	for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
		const loader = loaderOf(file);
		if (loader === null) continue;
		for (const specifier of specifiersOf(root, file, loader)) {
			// A bundler query or hash (`./page.html?raw`, `./icon.svg?url`) still reads the file
			// it names, so that file is what the key covers. Bun keeps the suffix on the path it
			// resolves, which names no file on disk. A leading '#' is a package.json imports
			// subpath ('#lib/helper.ts'), not a suffix, so the strip starts after the first character.
			const target = specifier.replace(/(?!^)[?#].*$/, '');
			let path: null | string;
			try {
				path = local(Bun.resolveSync(target, dirname(join(root, file))));
			} catch {
				if (isBare(target)) continue;
				throw new Error(`${file} imports '${specifier}', which resolves to no file`);
			}
			if (path === null || seen.has(path)) continue;
			seen.add(path);
			found.push(path);
			queue.push(path);
		}
	}
	return found;
}
