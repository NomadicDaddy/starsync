/**
 * A step's `cache` block in `smokestack.json`: what the step reads, so that the runner can replay
 * its last pass when none of that has changed. See cache.ts for what a replay requires.
 *
 * Caching is opt-in per file. A file in which no qc step has a `cache` block runs every step every
 * time, as it always did. Once any qc step has one, every qc step must: either a description of its
 * inputs or `{ "uncacheable": "<reason>" }`. A step that says neither is refused, because a step
 * left out of the cache by omission looks the same as one left out on purpose.
 *
 * Patterns are repository-relative with forward slashes, as git writes paths. `**` does not
 * descend into a directory whose name starts with a dot unless the pattern names it.
 */
import { asObject, asText, asTextList, fail } from './config-read.ts';

export interface OutputCheck {
	/** Text the file must contain. Null: it must exist and not be empty. */
	contains: null | string;
	/** A path or a glob. A glob must match at least one file. */
	path: string;
}

export type StepCache =
	| {
			collector: 'prettier' | null;
			excludes: string[];
			inputs: string[];
			inventory: 'git' | null;
			keyOnRevision: boolean;
			outputs: OutputCheck[];
			readsOutputs: string[];
			state: 'cached';
	  }
	| { reason: string; state: 'uncacheable' };

const CACHED_KEYS = [
	'collector',
	'excludes',
	'inputs',
	'inventory',
	'keyOnRevision',
	'outputs',
	'readsOutputs',
];

function asPattern(raw: unknown, where: string): string {
	const pattern = asText(raw, where);
	const segments = pattern.split('/');
	if (pattern.includes('\\') || pattern.startsWith('/') || /^[A-Za-z]:/u.test(pattern)) {
		fail(`${where} must be a repository-relative path with forward slashes.`);
	}
	if (segments.includes('..')) fail(`${where} must not leave the repository.`);
	return pattern;
}

function asPatterns(raw: unknown, where: string): string[] {
	return asTextList(raw, where).map((item, index) => asPattern(item, `${where}[${index}]`));
}

function asOutputs(raw: unknown, where: string): OutputCheck[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || raw.length === 0) fail(`${where} must be a non-empty list.`);
	return raw.map((item, index) => {
		const at = `${where}[${index}]`;
		if (typeof item === 'string') return { contains: null, path: asPattern(item, at) };
		const object = asObject(item, at, ['contains', 'path']);
		return {
			contains: asText(object['contains'], `${at}.contains`),
			path: asPattern(object['path'], `${at}.path`),
		};
	});
}

function asLiteral<T extends string>(raw: unknown, where: string, value: T): null | T {
	if (raw === undefined) return null;
	if (raw !== value) fail(`${where} must be '${value}'.`);
	return value;
}

/** Parses one step's `cache` block. `where` is the step's place in the file. */
export function parseStepCache(raw: unknown, where: string): StepCache {
	const at = `${where}.cache`;
	const probe = asObject(raw, at, ['uncacheable', ...CACHED_KEYS]);
	if ('uncacheable' in probe) {
		const object = asObject(raw, at, ['uncacheable']);
		return { reason: asText(object['uncacheable'], `${at}.uncacheable`), state: 'uncacheable' };
	}
	const keyOnRevision = probe['keyOnRevision'];
	if (keyOnRevision !== undefined && keyOnRevision !== true) {
		fail(`${at}.keyOnRevision must be true or left out.`);
	}
	const cache: StepCache = {
		collector: asLiteral(probe['collector'], `${at}.collector`, 'prettier'),
		excludes: asPatterns(probe['excludes'], `${at}.excludes`),
		inputs: asPatterns(probe['inputs'], `${at}.inputs`),
		inventory: asLiteral(probe['inventory'], `${at}.inventory`, 'git'),
		keyOnRevision: keyOnRevision === true,
		outputs: asOutputs(probe['outputs'], `${at}.outputs`),
		readsOutputs: asTextList(probe['readsOutputs'], `${at}.readsOutputs`),
		state: 'cached',
	};
	const reads =
		cache.inputs.length > 0 ||
		cache.inventory !== null ||
		cache.collector !== null ||
		cache.readsOutputs.length > 0;
	if (!reads) {
		fail(
			`${at} names nothing the step reads: give inputs, inventory, collector or ` +
				'readsOutputs, or mark it { "uncacheable": "<reason>" }.',
		);
	}
	return cache;
}

interface Cacheable {
	cache: null | StepCache;
	name: string;
}

/**
 * The rules across steps: once one qc step has a cache block every qc step needs one, and a step
 * that reads another's outputs names an earlier step that declares some.
 */
export function assertCacheCoverage(steps: readonly Cacheable[]): void {
	if (steps.every((step) => step.cache === null)) return;
	for (const [index, step] of steps.entries()) {
		const cache = step.cache;
		if (cache === null) {
			fail(
				`step '${step.name}' has no cache block. Once one step declares a cache, every ` +
					'step must: its inputs, or { "uncacheable": "<reason>" }.',
			);
		}
		if (cache.state !== 'cached') continue;
		for (const name of cache.readsOutputs) {
			const producer = steps.slice(0, index).find((earlier) => earlier.name === name);
			const outputs = producer?.cache?.state === 'cached' ? producer.cache.outputs : [];
			if (outputs.length === 0) {
				fail(
					`step '${step.name}' reads the outputs of '${name}', which is not an earlier ` +
						'step that declares outputs.',
				);
			}
		}
	}
}
