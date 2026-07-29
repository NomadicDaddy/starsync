import { execFile, type ExecFileException } from 'node:child_process';

import { isGitAuthError } from './secret-safety.ts';

/**
 * Options for async Git command execution.
 */
export interface GitExecOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	maxBuffer?: number;
}

const ALLOWED_GIT_ENVIRONMENT_KEYS = new Set([
	'COMSPEC',
	'GIT_OPTIONAL_LOCKS',
	'GIT_SSH',
	'GIT_SSH_COMMAND',
	'HOME',
	'HOMEDRIVE',
	'HOMEPATH',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'LANG',
	'LC_ALL',
	'LC_CTYPE',
	'NO_PROXY',
	'PATH',
	'PATHEXT',
	'SSH_AUTH_SOCK',
	'SystemRoot',
	'TEMP',
	'TMP',
	'TMPDIR',
	'USERPROFILE',
	'WINDIR',
	'http_proxy',
	'https_proxy',
	'no_proxy',
]);

const REJECTED_GIT_ENVIRONMENT_KEY = /token|password|passwd|secret|api[-_]?key|credential/i;

const copyAllowedEnvironment = (
	target: NodeJS.ProcessEnv,
	source: Readonly<NodeJS.ProcessEnv>
): void => {
	for (const [key, value] of Object.entries(source)) {
		if (
			value !== undefined &&
			ALLOWED_GIT_ENVIRONMENT_KEYS.has(key) &&
			!REJECTED_GIT_ENVIRONMENT_KEY.test(key)
		) {
			target[key] = value;
		}
	}
};

export const buildGitEnvironment = (
	source: Readonly<NodeJS.ProcessEnv> = process.env,
	overrides: Readonly<NodeJS.ProcessEnv> = {}
): NodeJS.ProcessEnv => {
	const environment: NodeJS.ProcessEnv = {};
	copyAllowedEnvironment(environment, source);
	copyAllowedEnvironment(environment, overrides);
	environment.GIT_TERMINAL_PROMPT = '0';
	return environment;
};

/**
 * Runs a Git command asynchronously and returns trimmed stdout.
 *
 * Uses execFile (no shell) to prevent injection. Sets GIT_TERMINAL_PROMPT=0
 * so credential prompts never block in non-interactive sessions.
 */
export const runGit = (args: string[], options: GitExecOptions): Promise<string> =>
	new Promise((resolve, reject) => {
		execFile(
			'git',
			args,
			{
				cwd: options.cwd,
				encoding: 'utf-8',
				env: buildGitEnvironment(process.env, options.env),
				maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
			},
			(err: ExecFileException | null, stdout: string) => {
				if (err) {
					reject(err);
				} else {
					resolve(stdout.trim());
				}
			}
		);
	});

// ── Error classification for retry decisions ───────────────────────────────

/**
 * Patterns matching clearly transient Git transport failures that are worth
 * a single retry: network timeouts, connection resets, RPC failures, etc.
 */
const TRANSIENT_GIT_PATTERNS: RegExp[] = [
	/connection timed out/i,
	/could not resolve host/i,
	/rpc failed/i,
	/early eof/i,
	/fetch-pack: unexpected disconnect/i,
	/the remote end hung up/i,
	/ssl routines/i,
	/connection was reset/i,
	/network is unreachable/i,
	/transient/i,
];

/**
 * Returns true when a Git error message indicates a transient transport
 * failure that is worth a single retry. Authentication failures, missing
 * repositories, invalid remotes, divergence, and integrity failures are
 * never considered transient.
 */
export const isTransientGitError = (message: string): boolean => {
	if (isGitAuthError(message)) return false;
	if (/repository not found|not found/i.test(message)) return false;
	if (/remote url mismatch/i.test(message)) return false;
	if (/merge conflict|divergent|unrelated histories/i.test(message)) return false;
	if (/corrupt|integrity|bad object/i.test(message)) return false;
	return TRANSIENT_GIT_PATTERNS.some((pattern) => pattern.test(message));
};
