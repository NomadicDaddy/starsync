import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { Octokit } from '@octokit/rest';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const HELP_TEXT = `starsync - clone or pull every starred GitHub repository.

Usage:
  bun index.ts [options] [target-path]

Options:
  --help, -h        Show this help

Environment:
  GITHUB_TOKEN      Required. Personal access token with repo + read:user scopes.
  TARGET_PATH       Optional. Used if no positional target-path is given.

A positional target-path argument overrides TARGET_PATH.
Default target: <repo>/starred_repos.`;

interface ParsedArgs {
	help: boolean;
	targetPath: string | null;
}

const parseArgs = (): ParsedArgs => {
	const parsed: ParsedArgs = { help: false, targetPath: null };
	for (const arg of process.argv.slice(2)) {
		if (arg === '--help' || arg === '-h') {
			parsed.help = true;
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

const stripQuotes = (value: string): string => value.trim().replace(/^['"]|['"]$/g, '');

const resolveTargetPath = (positional: string | null): string => {
	if (positional) return path.resolve(positional);
	const envValue = process.env.TARGET_PATH ? stripQuotes(process.env.TARGET_PATH) : '';
	if (envValue) return path.resolve(envValue);
	return path.resolve(scriptDir, 'starred_repos');
};

const listFolders = (dirPath: string): Set<string> => {
	if (!fs.existsSync(dirPath)) return new Set();
	return new Set(
		fs
			.readdirSync(dirPath, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
	);
};

interface Repository {
	name: string;
	clone_url: string;
}

const cloneOrPull = (repo: Repository, targetBase: string, existing: Set<string>): boolean => {
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
		return true;
	} catch (error) {
		console.error(`Failed to ${verb} ${repo.name}: ${(error as Error).message}`);
		return false;
	}
};

const main = async (): Promise<void> => {
	const args = parseArgs();
	if (args.help) {
		console.log(HELP_TEXT);
		return;
	}

	loadDotenv({ path: path.join(scriptDir, '.env') });
	const token = process.env.GITHUB_TOKEN;
	if (!token) {
		console.error('GITHUB_TOKEN is not set in .env');
		process.exit(1);
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
		repos = response.map((r) => ({ name: r.name, clone_url: r.clone_url }));
	} catch (error) {
		console.error(`Error fetching repositories: ${(error as Error).message}`);
		process.exit(1);
	}

	let succeeded = 0;
	let failed = 0;
	for (const repo of repos) {
		if (cloneOrPull(repo, targetBase, existing)) {
			succeeded++;
		} else {
			failed++;
		}
	}

	console.log(`\nSync complete. Succeeded: ${succeeded}. Failed: ${failed}.`);
	if (failed > 0) process.exit(1);
};

main().catch((error) => {
	console.error(`Unexpected error: ${(error as Error).message}`);
	process.exit(1);
});
