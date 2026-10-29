/**
 * The step cache's file: `.smokestack-cache.json` at the repository root, one entry per step that
 * last passed, with the key it passed under and the hash of every input it read.
 *
 * It is this checkout's memory alone. It is never tracked and never delivered: a repository that
 * opts into the cache must ignore it in git, and the runner refuses to start until it does (see
 * `cacheIgnoreRefusal`). Nothing is lost by deleting it; every step runs once more.
 *
 * It is written whole, to a temporary file renamed over it, so an interrupted run leaves the last
 * complete version and never half of one.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pid } from 'node:process';

export const CACHE_FILE = '.smokestack-cache.json';
const STORE_VERSION = 2;

/** Everything besides the inputs that a step's pass depends on. */
export interface KeyParts {
	argv: string[];
	bun: string;
	/** A hash of the values of the environment keys the key includes, and with them .env files. */
	env: string;
	/** The commit, for a step keyed on it; otherwise null. */
	revision: null | string;
	/** A hash of the runner's own source. */
	runner: string;
	/** For a `bun run` step, a hash of package.json's scripts block; otherwise null. */
	scripts: null | string;
}

export interface Entry {
	/** Repository-relative POSIX path to the sha256 of its content. */
	inputs: Record<string, string>;
	key: KeyParts;
	recordedAt: string;
}

export interface Store {
	entries: Map<string, Entry>;
	/** Set when a file was there and could not be used, so the run says why nothing replays. */
	note: null | string;
}

function isTextRecord(raw: unknown): raw is Record<string, string> {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
	return Object.values(raw).every((value) => typeof value === 'string');
}

function isKey(raw: unknown): raw is KeyParts {
	if (raw === null || typeof raw !== 'object') return false;
	const key = raw as Record<string, unknown>;
	return (
		Array.isArray(key['argv']) &&
		key['argv'].every((part) => typeof part === 'string') &&
		typeof key['bun'] === 'string' &&
		typeof key['env'] === 'string' &&
		(key['revision'] === null || typeof key['revision'] === 'string') &&
		typeof key['runner'] === 'string' &&
		(key['scripts'] === null || typeof key['scripts'] === 'string')
	);
}

function isEntry(raw: unknown): raw is Entry {
	if (raw === null || typeof raw !== 'object') return false;
	const entry = raw as Record<string, unknown>;
	return (
		isTextRecord(entry['inputs']) &&
		isKey(entry['key']) &&
		typeof entry['recordedAt'] === 'string'
	);
}

/** Reads the cache. Missing is empty; anything unreadable is empty, with a note saying so. */
export function readStore(root: string): Store {
	let text: string;
	try {
		text = readFileSync(join(root, CACHE_FILE), 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT')
			return { entries: new Map(), note: null };
		throw err;
	}
	const unusable = {
		entries: new Map(),
		note: `${CACHE_FILE} could not be used; starting empty`,
	};
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return unusable;
	}
	if (raw === null || typeof raw !== 'object') return unusable;
	const { steps, version } = raw as Record<string, unknown>;
	if (version !== STORE_VERSION || steps === null || typeof steps !== 'object') return unusable;
	const entries = new Map<string, Entry>();
	for (const [name, entry] of Object.entries(steps)) {
		if (!isEntry(entry)) return unusable;
		entries.set(name, entry);
	}
	return { entries, note: null };
}

export function writeStore(root: string, entries: ReadonlyMap<string, Entry>): void {
	const steps = Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)));
	const path = join(root, CACHE_FILE);
	const temporary = `${path}.${pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify({ steps, version: STORE_VERSION }, null, '\t')}\n`);
	renameSync(temporary, path);
}

/**
 * Why the runner will not use a cache here, or null. Inside a git work tree the cache file must be
 * ignored: tracked or committable, it would carry one checkout's results into another. Outside one
 * there is nothing to commit it to.
 *
 * Outside is only what git says it is. git exits 128 there, and with the same code in a repository
 * it cannot read: a broken one, one it refuses as of dubious ownership (safe.directory), one it
 * lacks the permissions for. So 128 alone is unknown, and unknown refuses the cache with git's own
 * reason; only "not a git repository" counts as outside. A git that prints that in another
 * language refuses too, which costs a run its cache and never lets a committable one through.
 */
export function cacheIgnoreRefusal(root: string): null | string {
	let code: number;
	let reason: string;
	try {
		const run = Bun.spawnSync(['git', '-C', root, 'check-ignore', '-q', CACHE_FILE], {
			stderr: 'pipe',
			stdout: 'ignore',
			windowsHide: true,
		});
		code = run.exitCode;
		reason = run.stderr.toString().trim();
	} catch (err) {
		return `git could not be started to check that ${CACHE_FILE} is ignored (${String(err)})`;
	}
	if (code === 0) return null;
	if (code === 1) {
		return (
			`${CACHE_FILE} is not ignored by git here. Add /${CACHE_FILE} to .gitignore: it is ` +
			"this checkout's memory and must never be committed"
		);
	}
	if (reason.includes('not a git repository')) return null;
	return (
		`git could not say whether ${CACHE_FILE} is ignored here ` +
		`(exit ${code}: ${reason === '' ? 'no message' : reason})`
	);
}
