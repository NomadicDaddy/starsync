/**
 * The heavy-step policy: smokestack.json's `heavy` object, the environment's overrides, and the
 * slot folder, decided once per run. The slots themselves are heavy.ts.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pid as ownPid, platform } from 'node:process';

import { asObject, fail } from './config-read.ts';
import { heldSlotIsLive } from './heavy-files.ts';

/** Handed to a heavy step: the slot it holds. A runner it starts never waits on that folder. */
export const HEAVY_HELD = 'SMOKESTACK_HEAVY_HELD';

const DEFAULT_LIMIT = 1;
const DEFAULT_MAX_WAIT_SECONDS = 90 * 60;

export interface HeavyConfig {
	limit: number;
	maxWaitSeconds: number;
}

export interface HeavyPolicy {
	dir: string;
	limit: number;
	maxWaitMs: number;
	/** Why heavy steps run without waiting, or null when they wait. */
	off: null | string;
}

function whole(raw: unknown, where: string, min: number): number {
	if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min) {
		fail(`${where} must be a whole number of at least ${min}.`);
	}
	return raw;
}

/** smokestack.json's `heavy` object, or the defaults when it is absent. */
export function parseHeavy(raw: unknown): HeavyConfig {
	if (raw === undefined)
		return { limit: DEFAULT_LIMIT, maxWaitSeconds: DEFAULT_MAX_WAIT_SECONDS };
	const object = asObject(raw, 'heavy', ['limit', 'maxWaitSeconds']);
	return {
		limit:
			object['limit'] === undefined
				? DEFAULT_LIMIT
				: whole(object['limit'], 'heavy.limit', 0),
		maxWaitSeconds:
			object['maxWaitSeconds'] === undefined
				? DEFAULT_MAX_WAIT_SECONDS
				: whole(object['maxWaitSeconds'], 'heavy.maxWaitSeconds', 1),
	};
}

function defaultDir(env: Record<string, string | undefined>): string {
	if (platform === 'win32')
		return join(env['ProgramData'] ?? 'C:\\ProgramData', 'smokestack', 'heavy');
	return '/tmp/smokestack-heavy';
}

/** The policy for this run: the config, with the environment's overrides laid over it. */
function heavyPolicy(config: HeavyConfig, env: Record<string, string | undefined>): HeavyPolicy {
	const fromEnv = (name: string, min: number, fallback: number): number => {
		const text = env[name];
		if (text === undefined || text === '') return fallback;
		const value = Number(text);
		if (!Number.isInteger(value) || value < min) {
			throw new Error(`${name}=${text} must be a whole number of at least ${min}.`);
		}
		return value;
	};
	const limit = fromEnv('SMOKESTACK_HEAVY_LIMIT', 0, config.limit);
	const maxWaitMs = fromEnv('SMOKESTACK_HEAVY_MAX_WAIT', 1, config.maxWaitSeconds) * 1000;
	const dir = resolve(env['SMOKESTACK_HEAVY_DIR'] || defaultDir(env));
	const held = env[HEAVY_HELD];
	let off: null | string = null;
	if (limit === 0) off = 'the heavy-step limit is 0';
	else if (held !== undefined && resolve(held).startsWith(dir + sep) && heldSlotIsLive(held)) {
		off = 'this gate runs inside a heavy step of another gate, which holds the slot';
	} else {
		try {
			mkdirSync(dir, { recursive: true });
			const probe = join(dir, `.probe-${ownPid}`);
			writeFileSync(probe, '');
			rmSync(probe, { force: true });
		} catch (err) {
			off = `${dir} cannot be written (${err instanceof Error ? err.message : String(err)})`;
		}
	}
	return { dir, limit, maxWaitMs, off };
}

/**
 * How this run's heavy steps wait, said once before the steps. Null when the environment sets a
 * heavy value the runner cannot read, which is refused like a bad config. A run with no heavy step
 * touches no slot folder.
 */
export function heavyForRun(
	config: HeavyConfig,
	count: number,
	env: Record<string, string | undefined>,
): HeavyPolicy | null {
	if (count === 0) return { dir: '', limit: 0, maxWaitMs: 0, off: 'no step is heavy' };
	let policy: HeavyPolicy;
	try {
		policy = heavyPolicy(config, env);
	} catch (err) {
		console.error(`[FAIL] ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
	if (policy.off === null) {
		const minutes = Math.round(policy.maxWaitMs / 60_000);
		console.info(
			`heavy: ${count} step(s) wait for a free slot (limit ${policy.limit}, up to ${minutes}m) in ${policy.dir}`,
		);
	} else {
		console.info(`heavy: ${count} step(s) run without waiting: ${policy.off}`);
	}
	return policy;
}
