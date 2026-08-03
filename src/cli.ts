#!/usr/bin/env node
// The published `starsync` binary is the node-target bundle at dist/cli.js, and `bun build`
// copies this shebang into it verbatim, so it has to name the runtime that bundle expects.
// Contributors run the TypeScript through bun explicitly (`bun src/cli.ts`), which ignores it.

import { isSubcommand, type Subcommand } from './lib/cli-utils.ts';
import { ROOT_HELP_TEXT } from './lib/help-text.ts';
import { sanitizeMessage } from './lib/secret-safety.ts';
import {
	dispatchDates,
	dispatchInit,
	dispatchRename,
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
		case 'rename':
			return dispatchRename(rest);
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

	const firstArg = argv[0];

	if (firstArg !== undefined && isSubcommand(firstArg)) {
		process.exit(await tryDispatch(firstArg, argv.slice(1)));
	}

	if (firstArg !== undefined && HELP_FLAGS.has(firstArg) && argv.length === 1) {
		console.log(ROOT_HELP_TEXT);
		process.exit(0);
	}

	console.error('Invalid usage: an explicit StarSync command is required.');
	console.log(ROOT_HELP_TEXT);
	process.exit(2);
} catch (err) {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`Unexpected error: ${sanitizeMessage(message)}`);
	process.exit(1);
}
