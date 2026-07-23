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

const GIT_ENV: NodeJS.ProcessEnv = {
	...process.env,
	GIT_TERMINAL_PROMPT: '0',
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
				env: { ...GIT_ENV, ...options.env },
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
