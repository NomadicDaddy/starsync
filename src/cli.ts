#!/usr/bin/env bun

import { isSubcommand, type Subcommand } from './lib/cli-utils.ts';
import { ROOT_HELP_TEXT } from './lib/help-text.ts';
import {
	dispatchDates,
	dispatchInit,
	dispatchMigrate,
	dispatchSync,
	dispatchUnlock,
	dispatchVerify,
} from './lib/subcommands.ts';

const HELP_FLAGS = new Set(['--help', '-h']);

const tryDispatch = async (sub: Subcommand, rest: string[]): Promise<number> => {
	switch (sub) {
		case 'dates':
			return dispatchDates(rest);
		case 'init':
			return dispatchInit(rest);
		case 'migrate':
			return dispatchMigrate(rest);
		case 'sync':
			return dispatchSync(rest);
		case 'unlock':
			return dispatchUnlock(rest);
		case 'verify':
			return dispatchVerify(rest);
	}
};

try {
	const argv = process.argv.slice(2);

	// Check if first non-flag arg is a recognized subcommand
	const firstArg = argv[0];

	if (firstArg !== undefined && isSubcommand(firstArg)) {
		process.exit(await tryDispatch(firstArg, argv.slice(1)));
	}

	// No subcommand: bare invocation — deprecated alias for sync (1.x)
	if (firstArg !== undefined && HELP_FLAGS.has(firstArg) && argv.length === 1) {
		// starsync --help (no subcommand) → show root help
		console.log(ROOT_HELP_TEXT);
		process.exit(0);
	}

	// Bare starsync [target-path] — deprecated alias for sync
	console.warn("Warning: bare starsync is deprecated; use 'starsync sync' instead.");
	process.exit(await dispatchSync(argv));
} catch (err) {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`Unexpected error: ${message}`);
	process.exit(1);
}
