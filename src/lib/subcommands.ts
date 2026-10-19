import type { CommandReport } from './reporting.ts';

import {
	initArchive,
	normalizeArchiveDates,
	renameArchive,
	syncArchive,
	unlockArchive,
	verifyArchive,
} from './archive-api.ts';
import { tokenForArchive, tokenForHost } from './cli-host.ts';
import { resolveArchiveTarget } from './cli-target.ts';
import {
	parseArgs,
	type ParsedSubcommandArgs,
	parseSubcommandArgs,
	type Subcommand,
} from './cli-utils.ts';
import {
	DATES_HELP_TEXT,
	INIT_HELP_TEXT,
	RENAME_HELP_TEXT,
	SYNC_HELP_TEXT,
	UNLOCK_HELP_TEXT,
	VERIFY_HELP_TEXT,
} from './help-text.ts';
import { createInterruptControl } from './interrupt-control.ts';
import { createCommandReport, createCommandReporter, createFinding } from './reporting.ts';

const emitHelp = (command: Subcommand, json: boolean, helpText: string): number => {
	createCommandReporter(json).emit(
		createCommandReport({ command, exitCode: 0, helpText, targetPath: null }),
	);
	return 0;
};

const emitUsageError = (
	command: Subcommand,
	argv: string[],
	helpText: string,
	err: unknown,
): number => {
	const message = err instanceof Error ? err.message : String(err);
	createCommandReporter(argv.includes('--json')).emit(
		createCommandReport({
			command,
			dryRun: argv.includes('--dry-run'),
			exitCode: 2,
			findings: [createFinding('error', 'invalid-usage', message)],
			helpText,
			targetPath: null,
		}),
	);
	return 2;
};

const resolveRequiredTarget = (
	command: Subcommand,
	argv: string[],
	helpText: string,
	args: Pick<ParsedSubcommandArgs, 'host' | 'targetPath'>,
): null | string => {
	try {
		return resolveArchiveTarget(args);
	} catch (err) {
		emitUsageError(command, argv, helpText, err);
		return null;
	}
};

export const dispatchSync = async (argv: string[]): Promise<number> => {
	const reporter = createCommandReporter(argv.includes('--json'));
	let args;
	try {
		args = parseArgs(argv);
	} catch (err) {
		return emitUsageError('sync', argv, SYNC_HELP_TEXT, err);
	}
	if (args.help) return emitHelp('sync', args.json, SYNC_HELP_TEXT);

	const targetPath = resolveRequiredTarget('sync', argv, SYNC_HELP_TEXT, args);
	if (targetPath === null) return 2;
	const interrupt = createInterruptControl(
		reporter,
		'Interrupt received — finishing in-flight operations and reporting partial results.',
	);
	let report: CommandReport;
	try {
		report = await syncArchive({
			concurrency: args.concurrency,
			dryRun: args.dryRun,
			minFreeSpace: args.minFreeSpace,
			onProgress: reporter.progress,
			signal: interrupt.signal,
			targetPath,
			token: tokenForArchive(targetPath),
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
		args = parseSubcommandArgs(argv, { allowForce: true, allowMinFreeSpace: true });
	} catch (err) {
		return emitUsageError('verify', argv, VERIFY_HELP_TEXT, err);
	}
	if (args.help) return emitHelp('verify', args.json, VERIFY_HELP_TEXT);

	const targetPath = resolveRequiredTarget('verify', argv, VERIFY_HELP_TEXT, args);
	if (targetPath === null) return 2;
	const reporter = createCommandReporter(args.json);
	const interrupt = createInterruptControl(
		reporter,
		'Interrupt received — finishing in-flight checks and reporting partial results.',
	);
	let report: CommandReport;
	try {
		report = await verifyArchive({
			force: args.force,
			minFreeSpace: args.minFreeSpace,
			onProgress: reporter.progress,
			signal: interrupt.signal,
			targetPath,
			token: tokenForArchive(targetPath),
		});
	} finally {
		interrupt.dispose();
	}
	reporter.emit(report);
	return report.exitCode;
};

export const dispatchRename = async (argv: string[]): Promise<number> => {
	let args: ParsedSubcommandArgs;
	try {
		args = parseSubcommandArgs(argv, { allowApply: true });
	} catch (err) {
		return emitUsageError('rename', argv, RENAME_HELP_TEXT, err);
	}
	if (args.help) return emitHelp('rename', args.json, RENAME_HELP_TEXT);
	const targetPath = resolveRequiredTarget('rename', argv, RENAME_HELP_TEXT, args);
	if (targetPath === null) return 2;
	const reporter = createCommandReporter(args.json);
	const interrupt = createInterruptControl(
		reporter,
		'Interrupt received — finishing the current checkout and reporting partial results.',
	);
	let report: CommandReport;
	try {
		report = await renameArchive({
			apply: args.apply,
			onProgress: reporter.progress,
			signal: interrupt.signal,
			targetPath,
			token: tokenForArchive(targetPath),
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
		args = parseSubcommandArgs(argv, { allowDryRun: true });
	} catch (err) {
		return emitUsageError('dates', argv, DATES_HELP_TEXT, err);
	}
	if (args.help) return emitHelp('dates', args.json, DATES_HELP_TEXT);

	const targetPath = resolveRequiredTarget('dates', argv, DATES_HELP_TEXT, args);
	if (targetPath === null) return 2;
	const reporter = createCommandReporter(args.json);
	const interrupt = createInterruptControl(
		reporter,
		'Interrupt received — finishing the current checkout and reporting partial results.',
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
	const targetPath = resolveRequiredTarget('init', argv, INIT_HELP_TEXT, args);
	if (targetPath === null) return 2;
	const host = args.host ?? 'github.com';
	const reporter = createCommandReporter(args.json);
	const interrupt = createInterruptControl(
		reporter,
		'Interrupt received — stopping archive initialization before metadata is written.',
	);
	let report: CommandReport;
	try {
		report = await initArchive({
			host,
			onProgress: reporter.progress,
			signal: interrupt.signal,
			targetPath,
			token: tokenForHost(host),
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
		args = parseSubcommandArgs(argv, { allowForce: true });
	} catch (err) {
		return emitUsageError('unlock', argv, UNLOCK_HELP_TEXT, err);
	}
	if (args.help) return emitHelp('unlock', args.json, UNLOCK_HELP_TEXT);
	const targetPath = resolveRequiredTarget('unlock', argv, UNLOCK_HELP_TEXT, args);
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
