import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const runRealCommand = (
	command: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv = {},
): string => {
	const result = Bun.spawnSync({
		cmd: [command, ...args],
		cwd,
		env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
		stderr: 'pipe',
		stdin: 'ignore',
		stdout: 'pipe',
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`${command} ${args.join(' ')} failed: ${result.stderr.toString() || result.stdout.toString()}`,
		);
	}
	return result.stdout.toString().trim();
};

export const runRealGit = (args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): string =>
	runRealCommand('git', args, cwd, env);

interface RealRefreshFixture {
	archive: string;
	checkout: string;
	cloneUrl: string;
	origin: string;
	seed: string;
}

export const createRealRefreshFixture = (root: string): RealRefreshFixture => {
	const archive = path.join(root, 'archive');
	const checkout = path.join(archive, 'repository--example');
	const cloneUrl = 'https://github.com/example/repository.git';
	const origin = path.join(root, 'repository.git');
	const seed = path.join(root, 'seed');

	mkdirSync(archive);
	mkdirSync(seed);
	runRealGit(['init', '--initial-branch=main'], seed);
	runRealGit(['config', 'user.email', 'starsync@example.test'], seed);
	runRealGit(['config', 'user.name', 'StarSync Test'], seed);
	writeFileSync(path.join(seed, 'README.md'), '# repository\n');
	runRealGit(['add', 'README.md'], seed);
	runRealGit(['commit', '-m', 'initial'], seed);
	runRealGit(['clone', '--bare', seed, origin], root);
	runRealGit(['remote', 'add', 'origin', origin], seed);
	runRealGit(['clone', origin, checkout], archive);
	runRealGit(['config', 'user.email', 'starsync@example.test'], checkout);
	runRealGit(['config', 'user.name', 'StarSync Test'], checkout);
	runRealGit(['remote', 'set-url', 'origin', cloneUrl], checkout);
	runRealGit(
		['config', '--local', `url.${pathToFileURL(origin).href}.insteadOf`, cloneUrl],
		checkout,
	);
	runRealGit(['config', '--local', 'starsync.repository-id', '321'], checkout);
	runRealGit(['config', '--local', 'starsync.repository-slug', 'example/repository'], checkout);

	return { archive, checkout, cloneUrl, origin, seed };
};

export const addRealCommit = (
	repositoryPath: string,
	fileName: string,
	content: string,
	message: string,
): void => {
	writeFileSync(path.join(repositoryPath, fileName), content);
	runRealGit(['add', fileName], repositoryPath);
	runRealGit(['commit', '-m', message], repositoryPath);
};

export const pushRealBranch = (fixture: RealRefreshFixture, branch: string): void => {
	runRealGit(['push', 'origin', branch], fixture.seed);
};

export const runRealRefresh = (
	fixture: RealRefreshFixture,
	defaultBranch: string,
	labels: { cloneUrl: string; slug: string } = {
		cloneUrl: fixture.cloneUrl,
		slug: 'example/repository',
	},
): { message?: string; outcome: string } => {
	const repository = {
		clone_url: labels.cloneUrl,
		defaultBranch,
		folderName: path.basename(fixture.checkout),
		id: 321,
		name: 'repository',
		slug: labels.slug,
	};
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			path.resolve('test/helpers/run-staged-checkout.ts'),
			fixture.archive,
		],
		env: {
			...process.env,
			TEST_ARCHIVE_OWNER_ID: '7',
			TEST_REPOSITORY: JSON.stringify(repository),
		},
		stderr: 'pipe',
		stdin: 'ignore',
		stdout: 'pipe',
	});
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.toString() || result.stdout.toString());
	}
	return JSON.parse(result.stdout.toString()) as { message?: string; outcome: string };
};
