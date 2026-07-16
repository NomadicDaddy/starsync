import { Octokit } from '@octokit/rest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withApiRetry } from './lib/api-retry.ts';
import { resolveTargetPath as resolveTargetPathImpl } from './lib/cli-utils.ts';
import { processRepository, runSyncPool } from './lib/refresh.ts';
import {
	isGitAuthError,
	isGitHubDotComUrl,
	sanitizeMessage,
	sanitizeUrl,
	CREDENTIAL_GUIDANCE,
} from './lib/secret-safety.ts';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, '..');

export const HELP_TEXT = `starsync sync - clone or pull every starred GitHub repository.

Usage:
  starsync sync [options] [target-path]
  bun src/cli.ts sync [options] [target-path]

Options:
  --help, -h          Show this help
  --dry-run           Query stars and inspect the archive without cloning, pulling,
                      renaming, or modifying any Git data, folder names, or timestamps
  --concurrency=N     Number of repositories to process concurrently (default: 4,
                      range: 1-8; --concurrency=1 is sequential and deterministic)

Environment:
  GITHUB_TOKEN        Required. Personal access token with repo + read:user scopes.
  TARGET_PATH         Optional. Used if no positional target-path is given.

A positional target-path argument overrides TARGET_PATH.
Default target: <repo>/starred_repos.`;

export interface ParsedArgs {
	concurrency: number;
	dryRun: boolean;
	help: boolean;
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

export const parseArgs = (argv: string[] = process.argv.slice(2)): ParsedArgs => {
	const parsed: ParsedArgs = {
		concurrency: DEFAULT_CONCURRENCY,
		dryRun: false,
		help: false,
		targetPath: null,
	};
	for (const arg of argv) {
		if (arg === '--help' || arg === '-h') {
			parsed.help = true;
		} else if (arg === '--dry-run') {
			parsed.dryRun = true;
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

export { stripQuotes } from './lib/cli-utils.ts';

export const resolveTargetPath = (
	positional: null | string,
	envTarget: string | undefined = process.env.TARGET_PATH,
	baseDir: string = repoDir
): string => resolveTargetPathImpl(positional, envTarget, baseDir);

export const listFolders = (dirPath: string): Set<string> => {
	if (!fs.existsSync(dirPath)) return new Set();
	return new Set(
		fs
			.readdirSync(dirPath, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
	);
};

export interface Repository {
	clone_url: string;
	name: string;
}

export interface SyncFailure {
	message: string;
	name: string;
	verb: 'clone' | 'pull';
}

export type SyncResult = { failure: null; ok: true } | { failure: SyncFailure; ok: false };

export const normalizeRepoUrl = (url: string): string =>
	url
		.trim()
		.toLowerCase()
		.replace(/\.git$/, '')
		.replace(/\/+$/, '');

export const cloneOrPull = (
	repo: Repository,
	targetBase: string,
	existing: Set<string>
): SyncResult => {
	console.log(`\n${repo.name}`);

	// Validate that the repository origin is GitHub.com (reject GHE and other hosts)
	if (!isGitHubDotComUrl(repo.clone_url)) {
		const sanitized = sanitizeUrl(repo.clone_url);
		const msg = `Repository origin is not GitHub.com: ${sanitized}`;
		console.warn(`Skipping ${repo.name}: ${msg}`);
		return {
			failure: {
				message: msg,
				name: repo.name,
				verb: 'clone',
			},
			ok: false,
		};
	}

	const repoPath = path.join(targetBase, repo.name);
	const isCloned =
		(existing.has(repo.name) || fs.existsSync(repoPath)) &&
		fs.existsSync(path.join(repoPath, '.git'));
	const verb = isCloned ? 'pull' : 'clone';
	try {
		if (isCloned) {
			const remoteUrl = execFileSync(
				'git',
				['-C', repoPath, 'config', '--get', 'remote.origin.url'],
				{
					encoding: 'utf-8',
				}
			).trim();
			if (normalizeRepoUrl(remoteUrl) !== normalizeRepoUrl(repo.clone_url)) {
				const expectedSanitized = sanitizeUrl(repo.clone_url);
				const foundSanitized = sanitizeUrl(remoteUrl);
				const msg = `Remote URL mismatch (expected ${expectedSanitized}, found ${foundSanitized})`;
				console.warn(`Skipping ${repo.name}: ${msg}`);
				return {
					failure: {
						message: msg,
						name: repo.name,
						verb: 'clone',
					},
					ok: false,
				};
			}
			console.log('Repository is already available -> pulling');
			execFileSync('git', ['-c', 'core.askPass=', 'pull'], {
				cwd: repoPath,
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
				stdio: 'inherit',
			});
		} else {
			console.log('Repository not available -> cloning');
			execFileSync('git', ['-c', 'core.askPass=', 'clone', repo.clone_url], {
				cwd: targetBase,
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
				stdio: 'inherit',
			});
		}
		return { failure: null, ok: true };
	} catch (err) {
		const rawMessage = (err as Error).message;
		let message = sanitizeMessage(rawMessage);
		if (isGitAuthError(rawMessage)) {
			message = `${message}\n${CREDENTIAL_GUIDANCE}`;
		}
		console.error(`Failed to ${verb} ${repo.name}: ${message}`);
		return { failure: { message, name: repo.name, verb }, ok: false };
	}
};

const getErrorMessage = (err: unknown): string =>
	err instanceof Error ? err.message : String(err);

export const runStarsync = async (argv: string[] = process.argv.slice(2)): Promise<number> => {
	let args: ParsedArgs;
	try {
		args = parseArgs(argv);
	} catch (err) {
		console.error(getErrorMessage(err));
		console.error(HELP_TEXT);
		return 2;
	}
	if (args.help) {
		console.log(HELP_TEXT);
		return 0;
	}

	const token = process.env.GITHUB_TOKEN;
	if (!token) {
		console.error('GITHUB_TOKEN is not set');
		return 1;
	}

	const targetBase = resolveTargetPath(args.targetPath);
	if (!args.dryRun) {
		fs.mkdirSync(targetBase, { recursive: true });
	}
	console.log(`Target: ${targetBase}`);

	const existing = listFolders(targetBase);
	const octokit = new Octokit({ auth: token });

	let repos: Repository[];
	try {
		console.log('\nFetching starred repos...');
		const response = await withApiRetry(
			() =>
				octokit.paginate(octokit.rest.activity.listReposStarredByAuthenticatedUser, {
					per_page: 100,
				}),
			{ maxRetries: 2 }
		);
		repos = response.map((r) => ({ clone_url: r.clone_url, name: r.name }));
	} catch (err) {
		console.error(`Error fetching repositories: ${getErrorMessage(err)}`);
		return 1;
	}

	if (args.dryRun) {
		console.log('\n--dry-run: querying stars and inspecting the archive without changes.');
	}

	// Track retained checkouts (existing folders not in the starred list)
	const starredNames = new Set(repos.map((r) => r.name));
	const retained: string[] = [];
	for (const folderName of existing) {
		if (!starredNames.has(folderName)) {
			const gitPath = path.join(targetBase, folderName, '.git');
			if (fs.existsSync(gitPath)) {
				retained.push(folderName);
			}
		}
	}

	if (args.dryRun) {
		let dryRunSucceeded = 0;
		for (let i = 0; i < repos.length; i++) {
			const repo = repos[i]!;
			const repoPath = path.join(targetBase, repo.name);
			const isCloned =
				(existing.has(repo.name) || fs.existsSync(repoPath)) &&
				fs.existsSync(path.join(repoPath, '.git'));
			console.log(
				`\nSyncing ${i + 1}/${repos.length} — ${repo.name} — would ${isCloned ? 'refresh' : 'clone'}`
			);
			dryRunSucceeded++;
		}
		if (retained.length > 0) {
			console.log(`\nRetained checkouts (${retained.length}):`);
			for (const name of retained) {
				console.log(`  ${name}`);
			}
		}
		console.log(`\nSync complete (dry-run). Succeeded: ${dryRunSucceeded}. Failed: 0.`);
		return 0;
	}

	// Validate GitHub.com origins before processing
	const validRepos: Repository[] = [];
	const invalidFailures: { message: string; name: string }[] = [];
	for (const repo of repos) {
		if (!isGitHubDotComUrl(repo.clone_url)) {
			const sanitized = sanitizeUrl(repo.clone_url);
			const msg = `Repository origin is not GitHub.com: ${sanitized}`;
			console.warn(`Skipping ${repo.name}: ${msg}`);
			invalidFailures.push({ message: msg, name: repo.name });
		} else {
			validRepos.push(repo);
		}
	}

	console.log(`\nConcurrency: ${args.concurrency}`);

	const refreshResults = await runSyncPool(
		validRepos,
		(repo, isInterruptionRequested) =>
			processRepository(repo, targetBase, isInterruptionRequested),
		{ concurrency: args.concurrency, totalCount: validRepos.length }
	);

	// Tally outcomes
	let added = 0;
	let updated = 0;
	let current = 0;
	let blocked = 0;
	let skipped = 0;
	const failures: { message: string; name: string }[] = [...invalidFailures];

	for (const result of refreshResults) {
		switch (result.outcome) {
			case 'added':
				added++;
				break;
			case 'blocked': {
				blocked++;
				console.warn(
					`- ${result.name}: blocked — ${result.message ?? 'local state would be overwritten'}`
				);
				break;
			}
			case 'current':
				current++;
				break;
			case 'failed': {
				failures.push({ message: result.message ?? 'unknown error', name: result.name });
				console.error(`- ${result.name}: failed — ${result.message ?? 'unknown error'}`);
				break;
			}
			case 'skipped': {
				skipped++;
				console.warn(`- ${result.name}: skipped — ${result.message ?? 'interrupted'}`);
				break;
			}
			case 'updated':
				updated++;
				break;
			default:
				break;
		}
	}

	const succeeded = added + updated + current;
	console.log(
		`\nSync complete. Added: ${added}. Updated: ${updated}. Current: ${current}. Blocked: ${blocked}. Skipped: ${skipped}. Retained: ${retained.length}. Failed: ${failures.length}.`
	);
	console.log(`Succeeded: ${succeeded}.`);

	if (retained.length > 0) {
		console.log('Retained checkouts (no longer starred):');
		for (const name of retained) {
			console.log(`  ${name}`);
		}
	}

	if (failures.length > 0) {
		console.error('\nFailed repositories:');
		for (const failure of failures) {
			console.error(`- ${failure.name}: ${failure.message}`);
		}
		return 1;
	}
	return 0;
};
