import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Finding, CommandReport } from './reporting.ts';

import { HELP_TEXT, parseArgs } from '../index.ts';
import {
	initArchive,
	migrateArchive,
	normalizeArchiveDates,
	syncArchive,
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
import { createCommandReport, createCommandReporter, createFinding } from './reporting.ts';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, '..', '..');

export interface ParsedSubcommandArgs {
	apply: boolean;
	dryRun: boolean;
	help: boolean;
	json: boolean;
	targetPath: null | string;
}

const parseSubcommandArgs = (argv: string[]): ParsedSubcommandArgs => {
	const parsed: ParsedSubcommandArgs = {
		apply: false,
		dryRun: false,
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

const isFallbackTarget = (positional: null | string): boolean => {
	if (positional) return false;
	const envValue = process.env.TARGET_PATH ? stripQuotes(process.env.TARGET_PATH) : '';
	return !envValue;
};

const fallbackFinding = (positional: null | string): Finding[] =>
	isFallbackTarget(positional)
		? [
				createFinding(
					'warning',
					'fallback-target',
					'Falling back to the project-local starred_repos directory. Set TARGET_PATH or pass an explicit target path.'
				),
			]
		: [];

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

const emitUnavailable = (
	command: Subcommand,
	args: ParsedSubcommandArgs,
	message: string,
	includeFallback: boolean
): number => {
	const findings = includeFallback ? fallbackFinding(args.targetPath) : [];
	findings.push(createFinding('error', 'command-unavailable', message));
	const targetPath =
		args.targetPath || process.env.TARGET_PATH
			? resolveTargetPath(args.targetPath, process.env.TARGET_PATH, repoDir)
			: null;
	createCommandReporter(args.json).emit(
		createCommandReport({ command, exitCode: 1, findings, targetPath })
	);
	return 1;
};

const addCliFindings = (report: CommandReport, findings: Finding[]): CommandReport => {
	if (findings.length === 0) return report;
	return createCommandReport({
		checkouts: report.checkouts,
		command: report.command,
		dryRun: report.dryRun,
		exitCode: report.exitCode,
		findings: [...findings, ...report.findings],
		...(report.helpText === undefined ? {} : { helpText: report.helpText }),
		interrupted: report.interrupted,
		targetPath: report.targetPath,
	});
};

interface InterruptControl {
	dispose: () => void;
	signal: AbortSignal;
}

const createInterruptControl = (
	reporter: ReturnType<typeof createCommandReporter>,
	firstMessage: string
): InterruptControl => {
	const controller = new AbortController();
	let interruptionLevel = 0;
	const handler = () => {
		interruptionLevel++;
		if (interruptionLevel === 1) {
			reporter.diagnostic(firstMessage);
			controller.abort();
		} else {
			reporter.diagnostic('Second interrupt — stopping immediately.');
			process.exit(130);
		}
	};
	process.on('SIGINT', handler);
	return {
		dispose: () => process.removeListener('SIGINT', handler),
		signal: controller.signal,
	};
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

	const targetPath = resolveTargetPath(args.targetPath, process.env.TARGET_PATH, repoDir);
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
	report = addCliFindings(report, fallbackFinding(args.targetPath));
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

	const targetPath = resolveTargetPath(args.targetPath, process.env.TARGET_PATH, repoDir);
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
	report = addCliFindings(report, fallbackFinding(args.targetPath));
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
	const targetPath = resolveTargetPath(args.targetPath, process.env.TARGET_PATH, repoDir);
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
	report = addCliFindings(report, fallbackFinding(args.targetPath));
	reporter.emit(report);
	return report.exitCode;
};

export const dispatchDates = (argv: string[]): number => {
	let args: ParsedSubcommandArgs;
	try {
		args = parseSubcommandArgs(argv);
	} catch (err) {
		return emitUsageError('dates', argv, DATES_HELP_TEXT, err);
	}
	if (args.help) return emitHelp('dates', args.json, DATES_HELP_TEXT);

	const targetPath = resolveTargetPath(args.targetPath, process.env.TARGET_PATH, repoDir);
	const reporter = createCommandReporter(args.json);
	const interrupt = createInterruptControl(
		reporter,
		'Interrupt received — finishing the current checkout and reporting partial results.'
	);
	let report: CommandReport;
	try {
		report = normalizeArchiveDates({
			dryRun: args.dryRun,
			onProgress: reporter.progress,
			signal: interrupt.signal,
			targetPath,
		});
	} finally {
		interrupt.dispose();
	}
	report = addCliFindings(report, fallbackFinding(args.targetPath));
	reporter.emit(report);
	return report.exitCode;
};

export const dispatchInit = (argv: string[]): number => {
	let args: ParsedSubcommandArgs;
	try {
		args = parseSubcommandArgs(argv);
	} catch (err) {
		return emitUsageError('init', argv, INIT_HELP_TEXT, err);
	}
	if (args.help) return emitHelp('init', args.json, INIT_HELP_TEXT);
	const targetPath = resolveTargetPath(args.targetPath, process.env.TARGET_PATH, repoDir);
	const reporter = createCommandReporter(args.json);
	const report = initArchive({
		onProgress: reporter.progress,
		targetPath,
		token: process.env.GITHUB_TOKEN ?? '',
	});
	reporter.emit(report);
	return report.exitCode;
};

export const dispatchUnlock = (argv: string[]): number => {
	let args: ParsedSubcommandArgs;
	try {
		args = parseSubcommandArgs(argv);
	} catch (err) {
		return emitUsageError('unlock', argv, UNLOCK_HELP_TEXT, err);
	}
	if (args.help) return emitHelp('unlock', args.json, UNLOCK_HELP_TEXT);
	return emitUnavailable('unlock', args, 'Unlock is not available in this release.', false);
};
