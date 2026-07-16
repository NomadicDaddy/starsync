import { Octokit } from '@octokit/rest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CheckoutReport, Finding } from './lib/reporting.ts';

import { withApiRetry } from './lib/api-retry.ts';
import { resolveTargetPath as resolveTargetPathImpl, stripQuotes } from './lib/cli-utils.ts';
import { processRepository, runSyncPool, type RefreshResult } from './lib/refresh.ts';
import { createCommandReport, createCommandReporter, createFinding } from './lib/reporting.ts';
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
  --json              Emit one schema-versioned JSON result document on stdout
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

export { stripQuotes };

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

const isFallbackTarget = (targetPath: null | string): boolean => {
	if (targetPath !== null) return false;
	const envTarget = process.env.TARGET_PATH ? stripQuotes(process.env.TARGET_PATH) : '';
	return !envTarget;
};

const getFallbackFindings = (targetPath: null | string): Finding[] =>
	isFallbackTarget(targetPath)
		? [
				createFinding(
					'warning',
					'fallback-target',
					'Falling back to the project-local starred_repos directory. Set TARGET_PATH or pass an explicit target path.'
				),
			]
		: [];

const checkoutExists = (targetBase: string, name: string): boolean =>
	fs.existsSync(path.join(targetBase, name, '.git'));

const reportRefreshResult = (result: RefreshResult, targetBase: string): CheckoutReport => {
	const lifecycle = checkoutExists(targetBase, result.name) ? 'active' : null;
	switch (result.outcome) {
		case 'added':
			return {
				findings: [],
				lifecycle: 'active',
				name: result.name,
				outcome: 'added',
				pendingRename: false,
			};
		case 'blocked':
			return {
				findings: [
					createFinding(
						'error',
						'checkout-blocked',
						result.message ?? 'Local state would be overwritten.'
					),
				],
				lifecycle: 'blocked',
				name: result.name,
				outcome: 'failed',
				pendingRename: false,
			};
		case 'current':
			return {
				findings: [createFinding('info', 'checkout-current', 'Checkout is current.')],
				lifecycle: 'active',
				name: result.name,
				outcome: 'current',
				pendingRename: false,
			};
		case 'failed':
			return {
				findings: [
					createFinding(
						'error',
						'git-operation-failed',
						result.message ?? 'Unknown Git error.'
					),
				],
				lifecycle,
				name: result.name,
				outcome: 'failed',
				pendingRename: false,
			};
		case 'retained':
			return {
				findings: [
					createFinding(
						'info',
						'checkout-retained',
						'Checkout is no longer starred and was retained.'
					),
				],
				lifecycle: 'retained',
				name: result.name,
				outcome: 'skipped',
				pendingRename: false,
			};
		case 'skipped':
			return {
				findings: [
					createFinding(
						'warning',
						'operation-skipped',
						result.message ?? 'Operation was skipped.'
					),
				],
				lifecycle,
				name: result.name,
				outcome: 'skipped',
				pendingRename: false,
			};
		case 'updated':
			return {
				findings: [],
				lifecycle: 'active',
				name: result.name,
				outcome: 'updated',
				pendingRename: false,
			};
	}
};

export const runStarsync = async (argv: string[] = process.argv.slice(2)): Promise<number> => {
	const reporter = createCommandReporter(argv.includes('--json'));
	let args: ParsedArgs;
	try {
		args = parseArgs(argv);
	} catch (err) {
		reporter.emit(
			createCommandReport({
				command: 'sync',
				exitCode: 2,
				findings: [createFinding('error', 'invalid-usage', getErrorMessage(err))],
				helpText: HELP_TEXT,
				targetPath: null,
			})
		);
		return 2;
	}
	if (args.help) {
		reporter.emit(
			createCommandReport({
				command: 'sync',
				exitCode: 0,
				helpText: HELP_TEXT,
				targetPath: null,
			})
		);
		return 0;
	}

	const token = process.env.GITHUB_TOKEN;
	if (!token) {
		reporter.emit(
			createCommandReport({
				command: 'sync',
				dryRun: args.dryRun,
				exitCode: 1,
				findings: [createFinding('error', 'missing-token', 'GITHUB_TOKEN is not set.')],
				targetPath: null,
			})
		);
		return 1;
	}

	const targetBase = resolveTargetPath(args.targetPath);
	try {
		if (!args.dryRun) fs.mkdirSync(targetBase, { recursive: true });
	} catch (err) {
		reporter.emit(
			createCommandReport({
				command: 'sync',
				dryRun: args.dryRun,
				exitCode: 1,
				findings: [
					createFinding(
						'error',
						'target-create-failed',
						`Cannot create target directory: ${getErrorMessage(err)}`
					),
				],
				targetPath: targetBase,
			})
		);
		return 1;
	}
	reporter.progress(`Target: ${targetBase}`);

	const existing = listFolders(targetBase);
	const octokit = new Octokit({ auth: token });

	let repos: Repository[];
	try {
		reporter.progress('Fetching starred repositories...');
		const response = await withApiRetry(
			() =>
				octokit.paginate(octokit.rest.activity.listReposStarredByAuthenticatedUser, {
					per_page: 100,
				}),
			{ maxRetries: 2 }
		);
		repos = response.map((r) => ({ clone_url: r.clone_url, name: r.name }));
	} catch (err) {
		reporter.emit(
			createCommandReport({
				command: 'sync',
				dryRun: args.dryRun,
				exitCode: 1,
				findings: [
					createFinding(
						'error',
						'github-api-failed',
						`Error fetching repositories: ${sanitizeMessage(getErrorMessage(err))}`
					),
				],
				targetPath: targetBase,
			})
		);
		return 1;
	}

	const starredNames = new Set(repos.map((r) => r.name));
	const retained = [...existing].filter(
		(folderName) => !starredNames.has(folderName) && checkoutExists(targetBase, folderName)
	);
	const retainedReports: CheckoutReport[] = retained.map((name) => ({
		findings: [
			createFinding(
				'info',
				'checkout-retained',
				'Checkout is no longer starred and was retained.'
			),
		],
		lifecycle: 'retained',
		name,
		outcome: 'skipped',
		pendingRename: false,
	}));

	if (args.dryRun) {
		reporter.progress('Dry run: querying stars and inspecting the archive without changes.');
		const plannedReports = repos.map((repo, index): CheckoutReport => {
			const isCloned = checkoutExists(targetBase, repo.name);
			const plannedOutcome = isCloned ? 'updated' : 'added';
			reporter.progress(
				`Syncing ${index + 1}/${repos.length} — ${repo.name} — would ${isCloned ? 'refresh' : 'clone'}`
			);
			return {
				findings: [
					createFinding(
						'info',
						isCloned ? 'refresh-planned' : 'clone-planned',
						isCloned ? 'Checkout would be refreshed.' : 'Repository would be added.'
					),
				],
				lifecycle: isCloned ? 'active' : null,
				name: repo.name,
				outcome: 'skipped',
				pendingRename: false,
				plannedOutcome,
			};
		});
		reporter.emit(
			createCommandReport({
				checkouts: [...plannedReports, ...retainedReports],
				command: 'sync',
				dryRun: true,
				exitCode: 0,
				findings: getFallbackFindings(args.targetPath),
				targetPath: targetBase,
			})
		);
		return 0;
	}

	const validRepos: Repository[] = [];
	const invalidReports: CheckoutReport[] = [];
	for (const repo of repos) {
		if (!isGitHubDotComUrl(repo.clone_url)) {
			invalidReports.push({
				findings: [
					createFinding(
						'error',
						'invalid-origin',
						`Repository origin is not GitHub.com: ${sanitizeUrl(repo.clone_url)}`
					),
				],
				lifecycle: checkoutExists(targetBase, repo.name) ? 'active' : null,
				name: repo.name,
				outcome: 'failed',
				pendingRename: false,
			});
		} else {
			validRepos.push(repo);
		}
	}

	reporter.progress(`Concurrency: ${args.concurrency}`);

	const poolResult = await runSyncPool(
		validRepos,
		(repo, isInterruptionRequested) =>
			processRepository(repo, targetBase, isInterruptionRequested),
		{
			concurrency: args.concurrency,
			onDiagnostic: reporter.diagnostic,
			onProgress: reporter.progress,
			totalCount: validRepos.length,
		}
	);
	const refreshReports = poolResult.results.map((result) =>
		reportRefreshResult(result, targetBase)
	);
	const reportedNames = new Set(poolResult.results.map((result) => result.name));
	const interruptedReports = poolResult.interrupted
		? validRepos
				.filter((repo) => !reportedNames.has(repo.name))
				.map((repo): CheckoutReport => ({
					findings: [
						createFinding(
							'warning',
							'interrupted-before-start',
							'Operation was not scheduled because interruption was requested.'
						),
					],
					lifecycle: checkoutExists(targetBase, repo.name) ? 'active' : null,
					name: repo.name,
					outcome: 'skipped',
					pendingRename: false,
				}))
		: [];
	const checkouts = [
		...refreshReports,
		...interruptedReports,
		...invalidReports,
		...retainedReports,
	];
	const findings = getFallbackFindings(args.targetPath);
	if (poolResult.interrupted) {
		findings.push(
			createFinding(
				'warning',
				'interrupted',
				'Synchronization was interrupted; results are partial.'
			)
		);
	}
	const hasErrors = checkouts.some((checkout) =>
		checkout.findings.some((finding) => finding.severity === 'error')
	);
	const exitCode = poolResult.interrupted ? 130 : hasErrors ? 1 : 0;
	reporter.emit(
		createCommandReport({
			checkouts,
			command: 'sync',
			exitCode,
			findings,
			interrupted: poolResult.interrupted,
			targetPath: targetBase,
		})
	);
	return exitCode;
};
