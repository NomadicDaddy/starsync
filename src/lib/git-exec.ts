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
	'GIT_LFS_SKIP_SMUDGE',
	'GIT_OPTIONAL_LOCKS',
	'GIT_SSH',
	'GIT_SSH_COMMAND',
	'HOME',
	'HOMEDRIVE',
	'HOMEPATH',
	'http_proxy',
	'HTTP_PROXY',
	'https_proxy',
	'HTTPS_PROXY',
	'LANG',
	'LC_ALL',
	'LC_CTYPE',
	'no_proxy',
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
]);

const REJECTED_GIT_ENVIRONMENT_KEY = /token|password|passwd|secret|api[-_]?key|credential/i;

const copyAllowedEnvironment = (
	target: NodeJS.ProcessEnv,
	source: Readonly<NodeJS.ProcessEnv>,
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
	overrides: Readonly<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv => {
	const environment: NodeJS.ProcessEnv = {};
	copyAllowedEnvironment(environment, source);
	copyAllowedEnvironment(environment, overrides);
	environment.GIT_TERMINAL_PROMPT = '0';
	return environment;
};

/**
 * Runs a Git command asynchronously and returns stdout exactly as Git wrote it.
 *
 * Uses execFile (no shell) to prevent injection. Sets GIT_TERMINAL_PROMPT=0
 * so credential prompts never block in non-interactive sessions.
 */
const runGitRaw = (args: string[], options: GitExecOptions): Promise<string> =>
	new Promise((resolve, reject) => {
		execFile(
			'git',
			args,
			{
				cwd: options.cwd,
				encoding: 'utf-8',
				env: buildGitEnvironment(process.env, options.env),
				maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
				windowsHide: true,
			},
			(err: ExecFileException | null, stdout: string) => {
				if (err) {
					reject(err);
				} else {
					resolve(stdout);
				}
			},
		);
	});

/** Runs a Git command asynchronously and returns trimmed stdout. */
export const runGit = async (args: string[], options: GitExecOptions): Promise<string> =>
	(await runGitRaw(args, options)).trim();

// ── Porcelain status parsing ───────────────────────────────────────────────

const isRenameRecord = (record: string): boolean =>
	['C', 'R'].includes(record[0] ?? '') || ['C', 'R'].includes(record[1] ?? '');

/**
 * Returns every path reported by `git status --porcelain -z`.
 *
 * The NUL-separated form is used rather than the default output because it
 * never quotes or escapes a path, and repositories may legitimately contain
 * spaces, quotes, and other characters that the quoted form rewrites. Rename
 * and copy records carry their origin path in a second NUL-separated field.
 */
export const parsePorcelainStatusPaths = (output: string): string[] => {
	const records = output.split('\0').filter((record) => record.length > 0);
	const paths: string[] = [];
	for (let index = 0; index < records.length; index++) {
		const record = records[index] ?? '';
		if (record.length < 4) continue;
		paths.push(record.slice(3));
		if (!isRenameRecord(record)) continue;
		const origin = records[index + 1];
		if (origin !== undefined) paths.push(origin);
		index++;
	}
	return paths;
};

/**
 * Reads the paths `git status` reports for a checkout.
 *
 * Output is read untrimmed, because a record whose index field is empty starts
 * with a space that carries meaning and trimming would shift the first path.
 */
export const readStatusPaths = async (args: string[], options: GitExecOptions): Promise<string[]> =>
	parsePorcelainStatusPaths(await runGitRaw([...args, 'status', '--porcelain', '-z'], options));

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
	// Filesystem contention, which is as transient as a dropped connection and was previously
	// the one class of transient failure with no retry at all. An indexer, an antivirus scanner,
	// or a git child process that has not fully exited can hold a handle to a file in a tree
	// being cloned into, renamed, or removed; the operation fails with a sharing violation and
	// succeeds moments later. Windows is where this bites, because it denies the unlink or the
	// rename outright rather than deferring it the way POSIX does.
	//
	// The parenthesized SSH form, `Permission denied (publickey).`, is an authentication failure
	// rather than contention. It stays non-transient because isGitAuthError is consulted first
	// and its pattern requires those parentheses.
	/permission denied/i,
	/access is denied/i,
	/being used by another process/i,
	/resource busy or locked/i,
	/operation not permitted/i,
	/\b(?:eacces|ebusy|eperm)\b/i,
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
