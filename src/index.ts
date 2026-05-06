import { Octokit } from '@octokit/rest';
import { config as loadDotenv } from 'dotenv';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, '..');

export const HELP_TEXT = `starsync - clone or pull every starred GitHub repository.

Usage:
  starsync [options] [target-path]
  bun src/cli.ts [options] [target-path]

Options:
  --help, -h        Show this help

Environment:
  GITHUB_TOKEN      Required. Personal access token with repo + read:user scopes.
  TARGET_PATH       Optional. Used if no positional target-path is given.

A positional target-path argument overrides TARGET_PATH.
Default target: <repo>/starred_repos.`;

export interface ParsedArgs {
	help: boolean;
	targetPath: null | string;
}

export const parseArgs = (argv: string[] = process.argv.slice(2)): ParsedArgs => {
	const parsed: ParsedArgs = { help: false, targetPath: null };
	for (const arg of argv) {
		if (arg === '--help' || arg === '-h') {
			parsed.help = true;
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
	envTarget: string | undefined = process.env.TARGET_PATH,
	baseDir: string = repoDir
): string => {
	if (positional) return path.resolve(positional);
	const envValue = envTarget ? stripQuotes(envTarget) : '';
	if (envValue) return path.resolve(envValue);
	return path.resolve(baseDir, 'starred_repos');
};

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

type SyncResult = { failure: null; ok: true } | { failure: SyncFailure; ok: false };

const cloneOrPull = (repo: Repository, targetBase: string, existing: Set<string>): SyncResult => {
	console.log(`\n${repo.name}`);
	const repoPath = path.join(targetBase, repo.name);
	const isCloned = existing.has(repo.name) && fs.existsSync(path.join(repoPath, '.git'));
	const verb = isCloned ? 'pull' : 'clone';
	try {
		if (isCloned) {
			console.log('Repository is already available -> pulling');
			execFileSync('git', ['pull'], { cwd: repoPath, stdio: 'inherit' });
		} else {
			console.log('Repository not available -> cloning');
			execFileSync('git', ['clone', repo.clone_url], {
				cwd: targetBase,
				stdio: 'inherit',
			});
		}
		return { failure: null, ok: true };
	} catch (err) {
		const message = (err as Error).message;
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

	loadDotenv({ path: path.join(repoDir, '.env') });
	const token = process.env.GITHUB_TOKEN;
	if (!token) {
		console.error('GITHUB_TOKEN is not set in .env');
		return 1;
	}

	const targetBase = resolveTargetPath(args.targetPath);
	fs.mkdirSync(targetBase, { recursive: true });
	console.log(`Target: ${targetBase}`);

	const existing = listFolders(targetBase);
	const octokit = new Octokit({ auth: token });

	let repos: Repository[];
	try {
		console.log('\nFetching starred repos...');
		const response = await octokit.paginate(
			octokit.rest.activity.listReposStarredByAuthenticatedUser,
			{ per_page: 100 }
		);
		repos = response.map((r) => ({ clone_url: r.clone_url, name: r.name }));
	} catch (err) {
		console.error(`Error fetching repositories: ${getErrorMessage(err)}`);
		return 1;
	}

	let succeeded = 0;
	const failures: SyncFailure[] = [];
	for (const repo of repos) {
		const result = cloneOrPull(repo, targetBase, existing);
		if (result.ok) {
			succeeded++;
		} else {
			failures.push(result.failure);
		}
	}

	console.log(`\nSync complete. Succeeded: ${succeeded}. Failed: ${failures.length}.`);
	if (failures.length > 0) {
		console.error('\nFailed repositories:');
		for (const failure of failures) {
			console.error(`- ${failure.name} (${failure.verb}): ${failure.message}`);
		}
		return 1;
	}
	return 0;
};
