import path from 'node:path';

export interface ParsedArgs {
	concurrency: number;
	dryRun: boolean;
	help: boolean;
	json: boolean;
	targetPath: null | string;
}

export const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
const MIN_CONCURRENCY = 1;

const parseConcurrency = (value: string): number => {
	const num = Number(value);
	if (!Number.isInteger(num) || num < MIN_CONCURRENCY || num > MAX_CONCURRENCY) {
		throw new Error(
			`--concurrency must be an integer from ${MIN_CONCURRENCY} to ${MAX_CONCURRENCY}, got: ${value}`
		);
	}
	return num;
};

/** @deprecated Use the explicit options accepted by syncArchive instead. */
export const parseArgs = (argv: string[] = process.argv.slice(2)): ParsedArgs => {
	const parsed: ParsedArgs = {
		concurrency: DEFAULT_CONCURRENCY,
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
		} else if (arg === '--json') {
			parsed.json = true;
		} else if (arg.startsWith('--concurrency=')) {
			parsed.concurrency = parseConcurrency(arg.slice('--concurrency='.length));
		} else if (arg === '--concurrency') {
			throw new Error('--concurrency requires a value: use --concurrency=N');
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

export const stripQuotes = (value: string): string => value.trim().replace(/^['"]|['"]$/g, '');

export const resolveTargetPath = (
	positional: null | string,
	envTarget: string | undefined,
	baseDir: string
): string => {
	if (positional) return path.resolve(positional);
	const envValue = envTarget ? stripQuotes(envTarget) : '';
	if (envValue) return path.resolve(envValue);
	return path.resolve(baseDir, 'starred_repos');
};

export const SUBCOMMANDS = ['dates', 'init', 'migrate', 'sync', 'unlock', 'verify'] as const;

export type Subcommand = (typeof SUBCOMMANDS)[number];

export const isSubcommand = (arg: string): arg is Subcommand =>
	(SUBCOMMANDS as readonly string[]).includes(arg);
