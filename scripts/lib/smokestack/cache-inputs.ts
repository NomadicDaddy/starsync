/**
 * Resolves what a step's cache block says it reads into files, and hashes them.
 *
 * Every path is repository-relative with forward slashes, the way git writes it, whichever way it
 * was found: by a glob (Bun gives `\` on Windows), by git's inventory, or through Prettier. So one
 * file is one key on every platform and by every route.
 *
 * Never inputs, whatever a pattern says: `.git` and `node_modules` (a step that depends on
 * installed packages declares `bun.lock`), the cache file and its temporary sibling, and the
 * step's own declared outputs, which it writes and so would never hash the same after as before.
 */
import { readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

import type { OutputCheck, StepCache } from './cache-config.ts';

import { prettierFiles } from './cache-prettier.ts';
import { CACHE_FILE } from './cache-store.ts';

export type CachedSpec = Extract<StepCache, { state: 'cached' }>;

const NEVER_INPUT_SEGMENTS = new Set(['.git', 'node_modules']);

function isNeverInput(path: string): boolean {
	if (path === CACHE_FILE || path.startsWith(`${CACHE_FILE}.`)) return true;
	return path.split('/').some((segment) => NEVER_INPUT_SEGMENTS.has(segment));
}

function isFile(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/**
 * The files a pattern matches. `**` does not walk into a dot-directory unless the pattern names
 * it, as in a shell: `.githooks/*` reaches `.githooks/`, a pattern starting with `**` does not.
 */
export function globFiles(root: string, pattern: string): string[] {
	const found = new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true });
	return [...found].map((path) => path.split(sep).join('/'));
}

/** Every tracked file and every untracked one git does not ignore, that is on disk now. */
export function gitInventory(root: string): string[] {
	const run = Bun.spawnSync(
		['git', '-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
		{ stderr: 'pipe', stdout: 'pipe', windowsHide: true },
	);
	if (run.exitCode !== 0) {
		throw new Error(`git cannot list this repository's files: ${run.stderr.toString().trim()}`);
	}
	// A tracked file deleted from the worktree is listed and cannot be read; its absence still
	// changes the input set, which is what invalidates an older entry.
	return run.stdout
		.toString()
		.split('\0')
		.filter((path) => path !== '' && isFile(join(root, path)));
}

/** The outputs of the steps a step reads, by name, from the steps that declare them. */
export type Producers = ReadonlyMap<string, readonly OutputCheck[]>;

/** The files a step reads, sorted. Throws when they cannot be known; the step then just runs. */
export async function collectInputs(
	root: string,
	cache: CachedSpec,
	producers: Producers,
): Promise<string[]> {
	const files = new Set<string>();
	const add = (paths: string[]): void => {
		for (const path of paths) files.add(path);
	};
	for (const pattern of cache.inputs) add(globFiles(root, pattern));
	if (cache.inventory !== null || cache.collector !== null) {
		const inventory = gitInventory(root);
		if (cache.inventory !== null) add(inventory);
		if (cache.collector !== null) add(await prettierFiles(root, inventory));
	}
	for (const name of cache.readsOutputs) {
		for (const output of producers.get(name) ?? []) add(globFiles(root, output.path));
	}
	const excluded = [...cache.excludes, ...cache.outputs.map((output) => output.path)].map(
		(pattern) => new Bun.Glob(pattern),
	);
	return [...files]
		.filter((path) => !isNeverInput(path) && !excluded.some((glob) => glob.match(path)))
		.sort();
}

export function hashFiles(root: string, files: readonly string[]): Record<string, string> {
	const hashes: Record<string, string> = {};
	for (const file of files) {
		const hasher = new Bun.CryptoHasher('sha256');
		hashes[file] = hasher.update(readFileSync(join(root, file))).digest('hex');
	}
	return hashes;
}

/** Why the step's declared outputs do not allow a replay, or null when they do. */
export function outputShortfall(root: string, outputs: readonly OutputCheck[]): null | string {
	for (const output of outputs) {
		// An empty file is what an interrupted write leaves: no output.
		const files = globFiles(root, output.path).filter(
			(path) => statSync(join(root, path)).size > 0,
		);
		if (files.length === 0) return `output ${output.path} is missing`;
		const { contains } = output;
		if (contains === null) continue;
		const lacking = files.find(
			(path) => !readFileSync(join(root, path), 'utf8').includes(contains),
		);
		if (lacking !== undefined)
			return `output ${lacking} does not contain ${JSON.stringify(contains)}`;
	}
	return null;
}
