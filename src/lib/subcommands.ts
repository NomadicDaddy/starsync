import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Finding } from './reporting.ts';

import {
	createGitHubRepositoryResolver,
	getArchiveModificationFinding,
	previewArchiveMigration,
	type MigrationPreviewResult,
} from './archive-migration.ts';
import { verifyArchive, type ArchiveVerificationResult } from './archive-verification.ts';
import { resolveTargetPath, stripQuotes, type Subcommand } from './cli-utils.ts';
import { formatDatesTables, runDatesCommand } from './dates-command.ts';
import {
	DATES_HELP_TEXT,
	INIT_HELP_TEXT,
	MIGRATE_HELP_TEXT,
	UNLOCK_HELP_TEXT,
	VERIFY_HELP_TEXT,
} from './help-text.ts';
import { createCommandReport, createCommandReporter, createFinding } from './reporting.ts';
import { sanitizeMessage } from './secret-safety.ts';

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

export const dispatchSync = async (argv: string[]): Promise<number> => {
	const { runStarsync } = await import('../index.ts');
	return runStarsync(argv);
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
	reporter.progress(`Archive: ${targetPath}`);
	reporter.progress('Verification is read-only; no archive data will be changed.');
	let interruptionLevel = 0;
	const sigintHandler = () => {
		interruptionLevel++;
		if (interruptionLevel === 1) {
			reporter.diagnostic(
				'Interrupt received — finishing in-flight checks and reporting partial results.'
			);
		} else {
			reporter.diagnostic('Second interrupt — stopping immediately.');
			process.exit(130);
		}
	};
	process.on('SIGINT', sigintHandler);
	let result: ArchiveVerificationResult;
	try {
		result = await verifyArchive(targetPath, {
			isInterruptionRequested: () => interruptionLevel > 0,
			onProgress: reporter.progress,
		});
	} catch (err) {
		reporter.emit(
			createCommandReport({
				command: 'verify',
				exitCode: 1,
				findings: [
					...fallbackFinding(args.targetPath),
					createFinding(
						'error',
						'archive-verification-failed',
						`Archive verification failed: ${sanitizeMessage(
							err instanceof Error ? err.message : String(err)
						)}`
					),
				],
				targetPath,
			})
		);
		return 1;
	} finally {
		process.removeListener('SIGINT', sigintHandler);
	}
	reporter.emit(
		createCommandReport({
			checkouts: result.checkouts,
			command: 'verify',
			exitCode: result.exitCode,
			findings: [...fallbackFinding(args.targetPath), ...result.findings],
			interrupted: result.interrupted,
			targetPath,
		})
	);
	return result.exitCode;
};

export const dispatchMigrate = async (argv: string[]): Promise<number> => {
	let args: ParsedSubcommandArgs;
	try {
		args = parseSubcommandArgs(argv);
	} catch (err) {
		return emitUsageError('migrate', argv, MIGRATE_HELP_TEXT, err);
	}
	if (args.help) return emitHelp('migrate', args.json, MIGRATE_HELP_TEXT);
	if (args.apply) {
		return emitUnavailable(
			'migrate',
			args,
			'Migrate --apply is not available in this release.',
			true
		);
	}

	const targetPath = resolveTargetPath(args.targetPath, process.env.TARGET_PATH, repoDir);
	const reporter = createCommandReporter(args.json);
	const token = process.env.GITHUB_TOKEN;
	if (!token) {
		reporter.emit(
			createCommandReport({
				command: 'migrate',
				dryRun: true,
				exitCode: 1,
				findings: [
					...fallbackFinding(args.targetPath),
					createFinding(
						'error',
						'missing-token',
						'GITHUB_TOKEN is required to resolve repository identities.'
					),
				],
				targetPath,
			})
		);
		return 1;
	}

	reporter.progress(`Archive: ${targetPath}`);
	reporter.progress('Migration preview is read-only; no archive data will be changed.');
	let interruptionLevel = 0;
	const sigintHandler = () => {
		interruptionLevel++;
		if (interruptionLevel === 1) {
			reporter.diagnostic(
				'Interrupt received — finishing the current checkout and reporting partial results.'
			);
		} else {
			reporter.diagnostic('Second interrupt — stopping immediately.');
			process.exit(130);
		}
	};
	process.on('SIGINT', sigintHandler);
	let result: MigrationPreviewResult;
	try {
		result = await previewArchiveMigration(targetPath, createGitHubRepositoryResolver(token), {
			isInterruptionRequested: () => interruptionLevel > 0,
			onProgress: reporter.progress,
		});
	} catch (err) {
		reporter.emit(
			createCommandReport({
				command: 'migrate',
				dryRun: true,
				exitCode: 1,
				findings: [
					...fallbackFinding(args.targetPath),
					createFinding(
						'error',
						'migration-preview-failed',
						`Migration preview failed: ${sanitizeMessage(err instanceof Error ? err.message : String(err))}`
					),
				],
				targetPath,
			})
		);
		return 1;
	} finally {
		process.removeListener('SIGINT', sigintHandler);
	}
	reporter.emit(
		createCommandReport({
			checkouts: result.checkouts,
			command: 'migrate',
			dryRun: true,
			exitCode: result.exitCode,
			findings: [...fallbackFinding(args.targetPath), ...result.findings],
			interrupted: result.interrupted,
			targetPath,
		})
	);
	return result.exitCode;
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
	const archiveRestriction = getArchiveModificationFinding(targetPath);
	if (archiveRestriction) {
		reporter.emit(
			createCommandReport({
				command: 'dates',
				dryRun: args.dryRun,
				exitCode: 1,
				findings: [...fallbackFinding(args.targetPath), archiveRestriction],
				targetPath,
			})
		);
		return 1;
	}
	reporter.progress(`Root: ${targetPath}`);
	const result = runDatesCommand(targetPath, { dryRun: args.dryRun });
	reporter.emit(
		createCommandReport({
			checkouts: result.checkouts,
			command: 'dates',
			dryRun: args.dryRun,
			exitCode: result.exitCode,
			findings: [...fallbackFinding(args.targetPath), ...result.findings],
			targetPath,
		})
	);
	if (!args.json) {
		for (const line of formatDatesTables(result.displayRows)) reporter.progress(line);
	}
	return result.exitCode;
};

export const dispatchInit = (argv: string[]): number => {
	let args: ParsedSubcommandArgs;
	try {
		args = parseSubcommandArgs(argv);
	} catch (err) {
		return emitUsageError('init', argv, INIT_HELP_TEXT, err);
	}
	if (args.help) return emitHelp('init', args.json, INIT_HELP_TEXT);
	return emitUnavailable('init', args, 'Init is not available in this release.', false);
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
