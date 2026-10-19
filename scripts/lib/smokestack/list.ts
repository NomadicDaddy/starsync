/**
 * What `--list` prints: the steps a run would take, and nothing run.
 *
 * The text form answers a person; the `--json` form is for the readers that check a repository's
 * runbook or its wiring against the step list (aidd's check:smoke-docs and check:gates-wired,
 * Spernakit's sync-smoke-docs and check-smoke-steps), which need it in a stable shape. Both read
 * the config exactly as a run would, so a config a run refuses is refused here the same way, and
 * both keep the config's own order, so an unchanged config prints the same bytes.
 */
import type { Config, Step } from './config.ts';

import { describeEnv } from './env.ts';

/** How a step's result is reused: replayed under its cache key, never, or not declared. */
type CacheKind = 'cached' | 'none' | 'uncacheable';

interface ListedStep {
	cache: CacheKind;
	description: string;
	name: string;
	onlyIn: null | string;
	run: string[];
}

interface Listing {
	/** The keys every step is handed, or null when steps inherit the whole environment. */
	env: null | string[];
	/** Null when the config defines no fast gate. */
	fast: ListedStep[] | null;
	qc: ListedStep[];
}

function cacheKind(step: Step): CacheKind {
	if (step.cache === null) return 'none';
	return step.cache.state;
}

function listed(steps: Step[]): ListedStep[] {
	return steps.map((step) => ({
		cache: cacheKind(step),
		description: step.description,
		name: step.name,
		onlyIn: step.onlyIn,
		run: step.run,
	}));
}

function listing(config: Config): Listing {
	return {
		env: config.env === null ? null : [...config.env.pass],
		fast: config.fast === null ? null : listed(config.fast),
		qc: listed(config.qc),
	};
}

/** The text form, for the steps of one mode. */
export function printListing(config: Config, steps: Step[], mode: 'fast' | 'qc'): void {
	console.info(`smokestack: ${mode}, ${steps.length} step(s), nothing run`);
	console.info(describeEnv(config.env));
	for (const step of steps) {
		const where = step.onlyIn === null ? '' : `\tonly in ${step.onlyIn}`;
		const command = step.run.join(' ');
		console.info(`${step.name}\t${command}\t${cacheKind(step)}\t${step.description}${where}`);
	}
}

/** The JSON form: both modes, whatever mode was asked for. */
export function printListingJson(config: Config): void {
	console.info(JSON.stringify(listing(config), null, '\t'));
}
