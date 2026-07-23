#!/usr/bin/env bun

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTargetPath } from '../src/lib/cli-utils.ts';
import { dispatchDates } from '../src/lib/subcommands.ts';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, '..');

const HELP_TEXT = `set-folder-dates (deprecated alias for 'starsync dates') - set each repo folder's mtime to its latest commit time.

Usage:
  bun scripts/set-folder-dates.ts [options] [target-path]

Options:
  --dry-run         Print actions without modifying timestamps
  --help, -h        Show this help

Environment:
  TARGET_PATH       Used if no positional target-path is given.

Default target: <repo>/starred_repos.`;

interface ParsedArgs {
	dryRun: boolean;
	help: boolean;
	targetPath: null | string;
}

const parseArgs = (): ParsedArgs => {
	const parsed: ParsedArgs = { dryRun: false, help: false, targetPath: null };
	for (const arg of process.argv.slice(2)) {
		if (arg === '--help' || arg === '-h') {
			parsed.help = true;
		} else if (arg === '--dry-run') {
			parsed.dryRun = true;
		} else if (!arg.startsWith('-')) {
			if (parsed.targetPath !== null) {
				console.error(`Unexpected positional argument: ${arg}`);
				console.error(HELP_TEXT);
				process.exit(2);
			}
			parsed.targetPath = arg;
		} else {
			console.error(`Unknown argument: ${arg}`);
			console.error(HELP_TEXT);
			process.exit(2);
		}
	}
	return parsed;
};

const args = parseArgs();
if (args.help) {
	console.log(HELP_TEXT);
	process.exit(0);
}

console.warn("Warning: set-folder-dates is deprecated; use 'starsync dates' instead.");
const targetPath = resolveTargetPath(args.targetPath, process.env.TARGET_PATH, repoDir);
process.exit(dispatchDates([...(args.dryRun ? ['--dry-run'] : []), targetPath]));
