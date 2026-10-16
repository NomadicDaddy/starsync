/**
 * The step cache: a step whose last pass was recorded is replayed, not run, when nothing it
 * depends on has changed since.
 *
 * What a pass depends on is its key and its inputs. The key is the runner's own source, the Bun
 * version, the step's argument list (and package.json's scripts for a `bun run` step, whose script
 * is what runs), the values of the environment keys the key includes (with
 * them the repository's .env files, env.ts), and the commit for a step keyed on it. The inputs are
 * the path and content of every file its cache block resolves to (cache-inputs.ts). A replay also
 * needs the step's declared outputs to be on disk.
 *
 * The inputs are hashed before the step runs and again after it passes, and the pass is recorded
 * only when the two agree. A file edited while the step ran may not have been the content it
 * checked, so that pass is not recorded, and the next run runs the step again.
 *
 * A step that fails, or passes over changed inputs, loses its entry. `--force` runs every step and
 * still records what passes. Only steps run here are cached: the check against the lock is made
 * before the steps, by preflight.ts, on every run.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Step } from './config.ts';

import {
	type CachedSpec,
	collectInputs,
	hashFiles,
	outputShortfall,
	type Producers,
} from './cache-inputs.ts';
import { type Entry, type KeyParts, readStore, writeStore } from './cache-store.ts';
import { dotenvState } from './env.ts';

interface Snapshot {
	inputs: Record<string, string>;
	key: KeyParts;
}

type Assessment =
	{ before: null | Snapshot; reason: string; replay: false } | { reason: string; replay: true };

export interface CacheSession {
	assess: (step: Step) => Promise<Assessment>;
	/** Drops the step's entry: it ran and did not pass. */
	forget: (step: Step) => void;
	/** Called after the step passed. Says whether the pass was recorded, and if not why not. */
	record: (step: Step, before: Snapshot) => Promise<string>;
	/** Why a cache file present could not be used, or null. */
	storeNote: null | string;
}

function sha256(parts: readonly (string | Uint8Array)[]): string {
	const hasher = new Bun.CryptoHasher('sha256');
	for (const part of parts) hasher.update(part).update('\0');
	return hasher.digest('hex');
}

/**
 * A `bun run` step runs what package.json's script says, not what its argument list says, and a
 * script may run another, so such a step is keyed on the whole scripts block. Null otherwise.
 */
function scriptsKey(root: string, argv: readonly string[]): null | string {
	// Bun's own flags may come before `run` (`bun --bun run x`), so any `run` after `bun` counts. A
	// step that merely passes the word to a file is keyed as well, which can only withhold a replay.
	// The key reads the repository root's package.json: a step that runs another directory's
	// script (`bun --cwd dir run x`) must list dir/package.json among its cache inputs.
	if (argv[0] !== 'bun' || !argv.slice(1).includes('run')) return null;
	const manifest: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	const scripts =
		manifest !== null && typeof manifest === 'object' && 'scripts' in manifest
			? manifest.scripts
			: null;
	return sha256([JSON.stringify(scripts ?? null)]);
}

/** The runner's version is its source: an edit to it, in the owner or a consumer, invalidates. */
function runnerVersion(): string {
	const library = readdirSync(import.meta.dir)
		.filter((name) => name.endsWith('.ts'))
		.sort()
		.map((name) => [`lib/smokestack/${name}`, join(import.meta.dir, name)] as const);
	const entry = ['smokestack.ts', join(import.meta.dir, '..', '..', 'smokestack.ts')] as const;
	return sha256([entry, ...library].flatMap(([name, path]) => [name, readFileSync(path)]));
}

function revisionOf(root: string): string {
	const run = Bun.spawnSync(['git', '-C', root, 'rev-parse', 'HEAD'], {
		stderr: 'pipe',
		stdout: 'pipe',
		windowsHide: true,
	});
	if (run.exitCode !== 0) throw new Error('there is no commit to key it on');
	return run.stdout.toString().trim();
}

function inputChange(was: Record<string, string>, now: Record<string, string>): null | string {
	const paths = [...new Set([...Object.keys(was), ...Object.keys(now)])].sort();
	const changed = paths.filter((path) => was[path] !== now[path]);
	const [first] = changed;
	if (first === undefined) return null;
	const how =
		was[first] === undefined ? 'added' : now[first] === undefined ? 'removed' : 'changed';
	const more = changed.length > 1 ? ` (and ${changed.length - 1} more)` : '';
	return `input ${first} ${how}${more}`;
}

/** What differs between a recorded snapshot and a current one, or null when nothing does. */
function difference(was: Snapshot, now: Snapshot): null | string {
	if (was.key.runner !== now.key.runner) return 'the runner changed';
	if (was.key.bun !== now.key.bun) return `Bun changed (${was.key.bun} to ${now.key.bun})`;
	if (JSON.stringify(was.key.argv) !== JSON.stringify(now.key.argv)) return 'the command changed';
	if (was.key.scripts !== now.key.scripts) return "package.json's scripts changed";
	if (was.key.env !== now.key.env)
		return 'the keyed environment changed (a value or a .env file)';
	if (was.key.revision !== now.key.revision) return 'the commit changed';
	return inputChange(was.inputs, now.inputs);
}

export interface CacheOptions {
	force: boolean;
	/**
	 * The environment keys whose values every key includes: the config's `env.pass`, the whole of
	 * what a step is handed besides the runner's mark (env.ts). Empty when the config has no list:
	 * a step then inherits the whole environment, nothing says which of it a result depends on,
	 * and a step that depends on any of it must be marked uncacheable. Not empty, the key also
	 * covers the repository's .env files (env.ts).
	 */
	keyedEnv: readonly string[];
	/** Every qc step, so a step that reads another's outputs can find them. */
	qc: readonly Step[];
	root: string;
}

export function openCache(options: CacheOptions): CacheSession {
	const { force, root } = options;
	const store = readStore(root);
	const runner = runnerVersion();
	const producers: Producers = new Map(
		options.qc.flatMap((step) =>
			step.cache?.state === 'cached' ? [[step.name, step.cache.outputs] as const] : [],
		),
	);

	const snapshot = async (step: Step, cache: CachedSpec): Promise<Snapshot> => {
		// An unset key is its bare name, so unset and set-to-empty are two keys. With a list, the
		// .env files a step's own processes may load are keyed beside the values (env.ts).
		const values = options.keyedEnv.map((name) => {
			const value = process.env[name];
			return value === undefined ? name : `${name}=${value}`;
		});
		const dotenv = options.keyedEnv.length > 0 ? dotenvState(root) : [];
		const env = sha256([...values, ...dotenv]);
		const revision = cache.keyOnRevision ? revisionOf(root) : null;
		const scripts = scriptsKey(root, step.run);
		const key = { argv: step.run, bun: Bun.version, env, revision, runner, scripts };
		return { inputs: hashFiles(root, await collectInputs(root, cache, producers)), key };
	};
	const save = (): void => {
		writeStore(root, store.entries);
	};

	return {
		assess: async (step) => {
			const cache = step.cache;
			if (cache === null) return { before: null, reason: 'no cache declared', replay: false };
			if (cache.state === 'uncacheable') {
				return { before: null, reason: `uncacheable: ${cache.reason}`, replay: false };
			}
			let before: Snapshot;
			try {
				before = await snapshot(step, cache);
			} catch (err) {
				const why = err instanceof Error ? err.message : String(err);
				return { before: null, reason: `cannot be keyed: ${why}`, replay: false };
			}
			if (force) return { before, reason: '--force', replay: false };
			const entry = store.entries.get(step.name);
			if (entry === undefined) return { before, reason: 'no pass recorded', replay: false };
			const changed = difference(entry, before) ?? outputShortfall(root, cache.outputs);
			if (changed !== null) return { before, reason: changed, replay: false };
			return { reason: `unchanged since ${entry.recordedAt}`, replay: true };
		},
		forget: (step) => {
			if (store.entries.delete(step.name)) save();
		},
		record: async (step, before) => {
			const cache = step.cache;
			if (cache?.state !== 'cached') return 'pass not recorded: the step is not cached';
			let after: Snapshot;
			try {
				after = await snapshot(step, cache);
			} catch (err) {
				const why = err instanceof Error ? err.message : String(err);
				store.entries.delete(step.name);
				save();
				return `pass not recorded: its inputs could not be read again (${why})`;
			}
			const changed = difference(before, after);
			if (changed !== null) {
				store.entries.delete(step.name);
				save();
				return `pass not recorded: ${changed} while it ran`;
			}
			const entry: Entry = { ...after, recordedAt: new Date().toISOString() };
			store.entries.set(step.name, entry);
			save();
			return 'pass recorded';
		},
		storeNote: store.note,
	};
}
