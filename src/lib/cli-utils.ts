import path from 'node:path';

import { DEFAULT_MIN_FREE_SPACE_BYTES, parseFreeSpaceBytes } from './free-space.ts';

export interface ParsedArgs {
	concurrency: number;
	dryRun: boolean;
	help: boolean;
	json: boolean;
	minFreeSpace: number;
	targetPath: null | string;
}

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
const MIN_CONCURRENCY = 1;

const parseConcurrency = (value: string): number => {
	const num = Number(value);
	if (!Number.isInteger(num) || num < MIN_CONCURRENCY || num > MAX_CONCURRENCY) {
		throw new Error(
			`--concurrency must be an integer from ${MIN_CONCURRENCY} to ${MAX_CONCURRENCY}, got: ${value}`,
		);
	}
	return num;
};

const readFlagValue = (arg: string, flag: string, placeholder: string): null | string => {
	if (arg === flag) throw new Error(`${flag} requires a value: use ${flag}=${placeholder}`);
	return arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : null;
};

/**
 * Reads `--min-free-space=SIZE` from one argument, or null when the argument is
 * something else. Shared so `sync` and `verify` accept the same spelling and reject
 * the same values rather than drifting into two dialects of one flag.
 */
const readMinFreeSpaceFlag = (arg: string): null | number => {
	const value = readFlagValue(arg, '--min-free-space', 'SIZE');
	return value === null ? null : parseFreeSpaceBytes(value);
};

const applyValueFlag = (parsed: ParsedArgs, arg: string): boolean => {
	const concurrency = readFlagValue(arg, '--concurrency', 'N');
	if (concurrency !== null) {
		parsed.concurrency = parseConcurrency(concurrency);
		return true;
	}
	const minFreeSpace = readMinFreeSpaceFlag(arg);
	if (minFreeSpace !== null) {
		parsed.minFreeSpace = minFreeSpace;
		return true;
	}
	return false;
};

export const parseArgs = (argv: string[] = process.argv.slice(2)): ParsedArgs => {
	const parsed: ParsedArgs = {
		concurrency: DEFAULT_CONCURRENCY,
		dryRun: false,
		help: false,
		json: false,
		minFreeSpace: DEFAULT_MIN_FREE_SPACE_BYTES,
		targetPath: null,
	};
	for (const arg of argv) {
		if (applyValueFlag(parsed, arg)) continue;
		if (arg === '--help' || arg === '-h') {
			parsed.help = true;
		} else if (arg === '--dry-run') {
			parsed.dryRun = true;
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

export interface ParsedSubcommandArgs {
	apply: boolean;
	dryRun: boolean;
	force: boolean;
	help: boolean;
	json: boolean;
	minFreeSpace: number;
	targetPath: null | string;
}

export type SubcommandArgumentOptions = Partial<
	Record<'allowApply' | 'allowDryRun' | 'allowForce' | 'allowMinFreeSpace', boolean>
>;

interface BooleanFlag {
	field: 'apply' | 'dryRun' | 'force' | 'help' | 'json';
	gate?: 'allowApply' | 'allowDryRun' | 'allowForce';
	names: readonly string[];
}

/**
 * Table-driven so accepting one more flag is a row rather than another branch: a
 * gated flag its subcommand did not opt into stays unknown, which is what keeps
 * `starsync dates --force` an error instead of a silent no-op.
 */
const BOOLEAN_FLAGS: readonly BooleanFlag[] = [
	{ field: 'help', names: ['--help', '-h'] },
	{ field: 'json', names: ['--json'] },
	{ field: 'dryRun', gate: 'allowDryRun', names: ['--dry-run'] },
	{ field: 'apply', gate: 'allowApply', names: ['--apply'] },
	{ field: 'force', gate: 'allowForce', names: ['--force'] },
];

const applyBooleanFlag = (
	parsed: ParsedSubcommandArgs,
	arg: string,
	options: SubcommandArgumentOptions,
): boolean => {
	const flag = BOOLEAN_FLAGS.find(
		(candidate) =>
			candidate.names.includes(arg) &&
			(candidate.gate === undefined || options[candidate.gate] === true),
	);
	if (flag === undefined) return false;
	parsed[flag.field] = true;
	return true;
};

const applyMinFreeSpaceFlag = (
	parsed: ParsedSubcommandArgs,
	arg: string,
	options: SubcommandArgumentOptions,
): boolean => {
	if (options.allowMinFreeSpace !== true) return false;
	const minFreeSpace = readMinFreeSpaceFlag(arg);
	if (minFreeSpace === null) return false;
	parsed.minFreeSpace = minFreeSpace;
	return true;
};

export const parseSubcommandArgs = (
	argv: string[],
	options: SubcommandArgumentOptions = {},
): ParsedSubcommandArgs => {
	const parsed: ParsedSubcommandArgs = {
		apply: false,
		dryRun: false,
		force: false,
		help: false,
		json: false,
		minFreeSpace: DEFAULT_MIN_FREE_SPACE_BYTES,
		targetPath: null,
	};
	for (const arg of argv) {
		if (applyBooleanFlag(parsed, arg, options)) continue;
		if (applyMinFreeSpaceFlag(parsed, arg, options)) continue;
		if (arg.startsWith('-')) throw new Error(`Unknown argument: ${arg}`);
		if (parsed.targetPath !== null) {
			throw new Error(`Unexpected positional argument: ${arg}`);
		}
		parsed.targetPath = arg;
	}
	return parsed;
};

export const stripQuotes = (value: string): string => value.trim().replace(/^['"]|['"]$/g, '');

export const resolveTargetPath = (
	positional: null | string,
	envTarget: string | undefined,
): string => {
	if (positional) return path.resolve(positional);
	const envValue = envTarget ? stripQuotes(envTarget) : '';
	if (envValue) return path.resolve(envValue);
	throw new Error('A target path or TARGET_PATH is required.');
};

const SUBCOMMANDS = ['dates', 'init', 'rename', 'sync', 'unlock', 'verify'] as const;

export type Subcommand = (typeof SUBCOMMANDS)[number];

export const isSubcommand = (arg: string): arg is Subcommand =>
	(SUBCOMMANDS as readonly string[]).includes(arg);
