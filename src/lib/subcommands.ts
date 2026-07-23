import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CommandReport } from './reporting.ts';

import { HELP_TEXT, parseArgs } from '../index.ts';
import {
	initArchive,
	migrateArchive,
	normalizeArchiveDates,
	syncArchive,
	unlockArchive,
	verifyArchive,
} from './archive-api.ts';
import { resolveTargetPath, stripQuotes, type Subcommand } from './cli-utils.ts';
import {
	DATES_HELP_TEXT,
	INIT_HELP_TEXT,
	MIGRATE_HELP_TEXT,
	UNLOCK_HELP_TEXT,
	VERIFY_HELP_TEXT,
} from './help-text.ts';
import { createInterruptControl } from './interrupt-control.ts';
import { createCommandReport, createCommandReporter, createFinding } from './reporting.ts';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, '..', '..');

export interface ParsedSubcommandArgs {
	apply: boolean;
	dryRun: boolean;
	force: boolean;
	help: boolean;
	json: boolean;
	targetPath: null | string;
}

const parseSubcommandArgs = (argv: string[], allowForce = false): ParsedSubcommandArgs => {
	const parsed: ParsedSubcommandArgs = {
		apply: false,
		dryRun: false,
		force: false,
		help: false,
		json: false,
		targetPath: null,
	};
	for (const arg of argv) {
		if (arg === '--help' || arg === '-h') {
			parsed.help = true;
		} else if (arg === '--dry-run') {
			parsed.dryRun = true;
		} else if (arg === '--apply') {
			parsed.apply = true;
		} else if (arg === '--force' && allowForce) {
			parsed.force = true;
		} else if (arg === '--json') {
			parsed.json = true;
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

const emitHelp = (command: Subcommand, json: boolean, helpText: string): number => {
	createCommandReporter(json).emit(
		createCommandReport({ command, exitCode: 0, helpText, targetPath: null })
	);
	return 0;
};

const emitUsageError = (
	command: Subcommand,
	argv: string[],
	helpText: string,
	err: unknown
): number => {
	const message = err instanceof Error ? err.message : String(err);
	createCommandReporter(argv.includes('--json')).emit(
		createCommandReport({
			command,
			exitCode: 2,
			findings: [createFinding('error', 'invalid-usage', message)],
			helpText,
			targetPath: null,
		})
	);
	return 2;
};

const resolveRequiredTarget = (
	command: Subcommand,
	argv: string[],
	helpText: string,
	positional: null | string
): null | string => {
	const envValue = process.env.TARGET_PATH ? stripQuotes(process.env.TARGET_PATH) : '';
	if (positional === null && !envValue) {
		emitUsageError(
			command,
			argv,
			helpText,
			new Error('A target path or TARGET_PATH is required.')
		);
		return null;
	}
	return resolveTargetPath(positional, process.env.TARGET_PATH, repoDir);
};

export const dispatchSync = async (argv: string[]): Promise<number> => {
	const reporter = createCommandReporter(argv.includes('--json'));
	let args;
	try {
		args = parseArgs(argv);
	} catch (err) {
		return emitUsageError('sync', argv, HELP_TEXT, err);
	}
	if (args.help) return emitHelp('sync', args.json, HELP_TEXT);

	const targetPath = resolveRequiredTarget('sync', argv, HELP_TEXT, args.targetPath);
	if (targetPath === null) return 2;
	const interrupt = createInterruptControl(
		reporter,
		'Interrupt received — finishing in-flight operations and reporting partial results.'
	);
	let report: CommandReport;
	try {
		report = await syncArchive({
			concurrency: args.concurrency,
			dryRun: args.dryRun,
			onProgress: reporter.progress,
			signal: interrupt.signal,
			targetPath,
			token: process.env.GITHUB_TOKEN ?? '',
		});
	} finally {
		interrupt.dispose();
	}
	reporter.emit(report);
	return report.exitCode;
};

export const dispatchVerify = async (argv: string[]): Promise<number> => {
	let args: ParsedSubcommandArgs;
	try {
		args = parseSubcommandArgs(argv);
	} catch (err) {
		return emitUsageError('verify', argv, VERIFY_HELP_TEXT, err);
	}
	if (args.help) return emitHelp('verify', args.json, VERIFY_HELP_TEXT);

	const targetPath = resolveRequiredTarget('verify', argv, VERIFY_HELP_TEXT, args.targetPath);
	if (targetPath === null) return 2;
	const reporter = createCommandReporter(args.json);
	const interrupt = createInterruptControl(
		reporter,
		'Interrupt received — finishing in-flight checks and reporting partial results.'
	);
	let report: CommandReport;
	try {
		report = await verifyArchive({
			onProgress: reporter.progress,
			signal: interrupt.signal,
			targetPath,
		});
	} finally {
		interrupt.dispose();
	}
	reporter.emit(report);
	return report.exitCode;
};

export const dispatchMigrate = async (argv: string[]): Promise<number> => {
	let args: ParsedSubcommandArgs;
	try {
		args = parseSubcommandArgs(argv);
	} catch (err) {
		return emitUsageError('migrate', argv, MIGRATE_HELP_TEXT, err);
	}
	if (args.help) return emitHelp('migrate', args.json, MIGRATE_HELP_TEXT);
	const targetPath = resolveRequiredTarget('migrate', argv, MIGRATE_HELP_TEXT, args.targetPath);
	if (targetPath === null) return 2;
	const reporter = createCommandReporter(args.json);
	const interrupt = createInterruptControl(
		reporter,
		'Interrupt received — finishing the current checkout and reporting partial results.'
	);
	let report: CommandReport;
	try {
		report = await migrateArchive({
			apply: args.apply,
			onProgress: reporter.progress,
			signal: interrupt.signal,
			targetPath,
			token: process.env.GITHUB_TOKEN ?? '',
		});
	} finally {
		interrupt.dispose();
	}
	reporter.emit(report);
	return report.exitCode;
};

export const dispatchDates = async (argv: string[]): Promise<number> => {
	let args: ParsedSubcommandArgs;
	try {
		args = parseSubcommandArgs(argv);
	} catch (err) {
		return emitUsageError('dates', argv, DATES_HELP_TEXT, err);
	}
	if (args.help) return emitHelp('dates', args.json, DATES_HELP_TEXT);

	const targetPath = resolveRequiredTarget('dates', argv, DATES_HELP_TEXT, args.targetPath);
	if (targetPath === null) return 2;
	const reporter = createCommandReporter(args.json);
	const interrupt = createInterruptControl(
		reporter,
		'Interrupt received — finishing the current checkout and reporting partial results.'
	);
	let report: CommandReport;
	try {
		report = await normalizeArchiveDates({
			dryRun: args.dryRun,
			onProgress: reporter.progress,
			signal: interrupt.signal,
			targetPath,
		});
	} finally {
		interrupt.dispose();
	}
	reporter.emit(report);
	return report.exitCode;
};

export const dispatchInit = async (argv: string[]): Promise<number> => {
	let args: ParsedSubcommandArgs;
	try {
		args = parseSubcommandArgs(argv);
	} catch (err) {
		return emitUsageError('init', argv, INIT_HELP_TEXT, err);
	}
	if (args.help) return emitHelp('init', args.json, INIT_HELP_TEXT);
	const targetPath = resolveRequiredTarget('init', argv, INIT_HELP_TEXT, args.targetPath);
	if (targetPath === null) return 2;
	const reporter = createCommandReporter(args.json);
	const interrupt = createInterruptControl(
		reporter,
		'Interrupt received — stopping archive initialization before metadata is written.'
	);
	let report: CommandReport;
	try {
		report = await initArchive({
			onProgress: reporter.progress,
			signal: interrupt.signal,
			targetPath,
			token: process.env.GITHUB_TOKEN ?? '',
		});
	} finally {
		interrupt.dispose();
	}
	reporter.emit(report);
	return report.exitCode;
};

export const dispatchUnlock = (argv: string[]): number => {
	let args: ParsedSubcommandArgs;
	try {
		args = parseSubcommandArgs(argv, true);
	} catch (err) {
		return emitUsageError('unlock', argv, UNLOCK_HELP_TEXT, err);
	}
	if (args.help) return emitHelp('unlock', args.json, UNLOCK_HELP_TEXT);
	const targetPath = resolveRequiredTarget('unlock', argv, UNLOCK_HELP_TEXT, args.targetPath);
	if (targetPath === null) return 2;
	const reporter = createCommandReporter(args.json);
	const report = unlockArchive({
		force: args.force,
		onProgress: reporter.progress,
		targetPath,
	});
	reporter.emit(report);
	return report.exitCode;
};
