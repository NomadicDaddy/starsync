import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTargetPath, stripQuotes } from './cli-utils.ts';
import { runDatesCommand } from './dates-command.ts';
import {
	DATES_HELP_TEXT,
	INIT_HELP_TEXT,
	MIGRATE_HELP_TEXT,
	SYNC_HELP_TEXT,
	UNLOCK_HELP_TEXT,
	VERIFY_HELP_TEXT,
} from './help-text.ts';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, '..', '..');

export interface ParsedSubcommandArgs {
	apply: boolean;
	dryRun: boolean;
	help: boolean;
	targetPath: null | string;
}

const parseSubcommandArgs = (argv: string[]): ParsedSubcommandArgs => {
	const parsed: ParsedSubcommandArgs = {
		apply: false,
		dryRun: false,
		help: false,
		targetPath: null,
	};
	for (const arg of argv) {
		if (arg === '--help' || arg === '-h') {
			parsed.help = true;
		} else if (arg === '--dry-run') {
			parsed.dryRun = true;
		} else if (arg === '--apply') {
			parsed.apply = true;
		} else if (!arg.startsWith('-')) {
			if (parsed.targetPath !== null) {
				throw new Error(`Unexpected positional argument: ${arg}`);
			}
			parsed.targetPath = arg;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return parsed;
};

const isFallbackTarget = (positional: null | string): boolean => {
	if (positional) return false;
	const envValue = process.env.TARGET_PATH ? stripQuotes(process.env.TARGET_PATH) : '';
	return !envValue;
};

const warnFallback = (): void => {
	console.warn(
		'Warning: falling back to the project-local starred_repos directory. ' +
			'Set TARGET_PATH or pass an explicit target-path to avoid this.'
	);
};

export const dispatchSync = async (argv: string[]): Promise<number> => {
	let args: ParsedSubcommandArgs;
	try {
		args = parseSubcommandArgs(argv);
	} catch (err) {
		console.error((err as Error).message);
		console.error(SYNC_HELP_TEXT);
		return 2;
	}
	if (args.help) {
		console.log(SYNC_HELP_TEXT);
		return 0;
	}
	if (isFallbackTarget(args.targetPath)) warnFallback();
	const { runStarsync } = await import('../index.ts');
	return runStarsync(argv);
};

export const dispatchVerify = (argv: string[]): number => {
	let args: ParsedSubcommandArgs;
	try {
		args = parseSubcommandArgs(argv);
	} catch (err) {
		console.error((err as Error).message);
		console.error(VERIFY_HELP_TEXT);
		return 2;
	}
	if (args.help) {
		console.log(VERIFY_HELP_TEXT);
		return 0;
	}
	if (isFallbackTarget(args.targetPath)) warnFallback();
	console.error('verify: not available in this release');
	return 1;
};

export const dispatchMigrate = (argv: string[]): number => {
	let args: ParsedSubcommandArgs;
	try {
		args = parseSubcommandArgs(argv);
	} catch (err) {
		console.error((err as Error).message);
		console.error(MIGRATE_HELP_TEXT);
		return 2;
	}
	if (args.help) {
		console.log(MIGRATE_HELP_TEXT);
		return 0;
	}
	if (isFallbackTarget(args.targetPath)) warnFallback();
	if (args.apply) {
		console.error('migrate --apply: not available in this release');
		return 1;
	}
	console.error('migrate: not available in this release');
	return 1;
};

export const dispatchDates = (argv: string[]): number => {
	let args: ParsedSubcommandArgs;
	try {
		args = parseSubcommandArgs(argv);
	} catch (err) {
		console.error((err as Error).message);
		console.error(DATES_HELP_TEXT);
		return 2;
	}
	if (args.help) {
		console.log(DATES_HELP_TEXT);
		return 0;
	}
	if (isFallbackTarget(args.targetPath)) warnFallback();
	const target = resolveTargetPath(args.targetPath, process.env.TARGET_PATH, repoDir);
	const result = runDatesCommand(target, { dryRun: args.dryRun });
	return result.exitCode;
};

export const dispatchInit = (argv: string[]): number => {
	let args: ParsedSubcommandArgs;
	try {
		args = parseSubcommandArgs(argv);
	} catch (err) {
		console.error((err as Error).message);
		console.error(INIT_HELP_TEXT);
		return 2;
	}
	if (args.help) {
		console.log(INIT_HELP_TEXT);
		return 0;
	}
	console.error('init: not available in this release');
	return 1;
};

export const dispatchUnlock = (argv: string[]): number => {
	let args: ParsedSubcommandArgs;
	try {
		args = parseSubcommandArgs(argv);
	} catch (err) {
		console.error((err as Error).message);
		console.error(UNLOCK_HELP_TEXT);
		return 2;
	}
	if (args.help) {
		console.log(UNLOCK_HELP_TEXT);
		return 0;
	}
	console.error('unlock: not available in this release');
	return 1;
};
