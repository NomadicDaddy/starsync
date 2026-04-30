import { Octokit } from '@octokit/rest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as dotenv from 'dotenv';

dotenv.config();

const mytoken = process.env.GITHUB_TOKEN;
if (!mytoken) {
	console.error('GITHUB_TOKEN is not set in .env');
	process.exit(1);
}

const targetBasePath = process.env.TARGET_PATH || path.join(process.cwd(), 'starred_repos');

const octokit = new Octokit({
	auth: mytoken,
});

function getFolders(myPath: string): string[] {
	if (!fs.existsSync(myPath)) {
		fs.mkdirSync(myPath, { recursive: true });
		return [];
	}

	return fs
		.readdirSync(myPath, { withFileTypes: true })
		.filter((dirent) => dirent.isDirectory())
		.map((dirent) => dirent.name);
}

interface Repository {
	name: string;
	clone_url: string;
}

function cloneAndPull(repos: Repository[], currFolder: string[]) {
	for (const repo of repos) {
		console.log();
		console.log(repo.name);

		const repoPath = path.join(targetBasePath, repo.name);

		if (currFolder.includes(repo.name) && fs.existsSync(path.join(repoPath, '.git'))) {
			console.log('Repository is already available -> pulling');
			try {
				execSync('git pull', { cwd: repoPath, stdio: 'inherit' });
			} catch (e) {
				console.error(`Failed to pull ${repo.name}:`, e);
			}
		} else {
			console.log('Repository not available -> cloning');
			if (!fs.existsSync(targetBasePath)) {
				fs.mkdirSync(targetBasePath, { recursive: true });
			}
			try {
				execSync(`git clone ${repo.clone_url}`, { cwd: targetBasePath, stdio: 'inherit' });
			} catch (e) {
				console.error(`Failed to clone ${repo.name}:`, e);
			}
		}
	}
}

async function main() {
	const sFolders = getFolders(targetBasePath);

	try {
		// Starred repos
		console.log('\nFetching starred repos...');
		const starredRepos = await octokit.paginate(
			octokit.rest.activity.listReposStarredByAuthenticatedUser,
			{
				per_page: 100,
			}
		);
		cloneAndPull(starredRepos, sFolders);
	} catch (error) {
		console.error('Error fetching repositories:', error);
	}
}

main();
