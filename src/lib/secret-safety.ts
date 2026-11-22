/**
 * Secret safety utilities — separate GitHub API authentication from Git
 * transport authentication, prevent credentials from leaking into output,
 * and validate that all repository origins are GitHub.com.
 *
 * API authentication uses GITHUB_TOKEN via Octokit (listing stars).
 * Git transport authentication uses system Git credentials (Git Credential
 * Manager, SSH keys). StarSync never embeds the API token in Git operations.
 */

// ── Embedded credential detection ──────────────────────────────────────────

import type { ArchiveHost } from './archive-host.ts';

/** Matches user:password@ in an HTTPS URL. */
const EMBEDDED_USERPASS_RE = /(https?:\/\/)[^/@:]+:[^/@]+@/g;
/** Matches bare token@ in an HTTPS URL (no colon, just credentials before @). */
const EMBEDDED_TOKEN_RE = /(https?:\/\/)[^/@:]+@/g;

/**
 * Returns true when a URL contains embedded credentials
 * (user:password@ or token@ forms).
 */
export const hasEmbeddedCredentials = (url: string): boolean => {
	// Reset lastIndex because the /g flag is shared with replace() calls
	EMBEDDED_USERPASS_RE.lastIndex = 0;
	EMBEDDED_TOKEN_RE.lastIndex = 0;
	return EMBEDDED_USERPASS_RE.test(url) || EMBEDDED_TOKEN_RE.test(url);
};

/**
 * Strips embedded credentials from a URL so it can be safely printed.
 *
 *   https://user:token@github.com/owner/repo.git → https://github.com/owner/repo.git
 *   https://token@github.com/owner/repo.git       → https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git                 → unchanged (SSH, no embedded password)
 */
export const sanitizeUrl = (url: string): string =>
	url.replace(EMBEDDED_USERPASS_RE, '$1').replace(EMBEDDED_TOKEN_RE, '$1');

// ── Secret redaction ────────────────────────────────────────────────────────

/** GitHub classic PAT prefixes: ghp_ (personal), gho_ (OAuth), ghs_ (server), ghu_ (user). */
const SECRET_PATTERNS = [
	/\bgh[opsu]_[A-Za-z0-9]{36,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
	/\bsk-(?:[A-Za-z0-9]+-)*[A-Za-z0-9_-]{20,}\b/g,
	/\b(?:A3T[A-Z0-9]|ABIA|ACCA|AGPA|AIDA|AIPA|AKIA|ANPA|ANVA|APKA|AROA|ASCA|ASIA)[A-Z0-9]{16}\b/g,
	/\bAIza[A-Za-z0-9_-]{35}\b/g,
];

const AUTHORIZATION_HEADER_RE = /(\bauthorization\s*:\s*)[^\r\n]+/gi;
const AUTHORIZATION_VALUE_RE = /(\bauthorization\s*=\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&#,;]+)/gi;
const BEARER_TOKEN_RE = /(\bbearer\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi;
// The lookahead leaves a JSON value the quoted-field pass already redacted as it is, so the JSON
// stays valid instead of losing the value's quotes.
const GENERIC_SECRET_VALUE_RE =
	/((?:["']?)(?:(?:[A-Za-z0-9]+[-_])*(?:api[-_]?key|secret|token|password|passwd|pwd))["']?\s*(?:=|:)\s*)(?!"\[REDACTED\]")(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&#,;]+)/gi;

/**
 * A double-quoted secret key, its colon and the opening quote of its string value, at any JSON
 * escaping depth. JSON carried inside a JSON string escapes its quotes, so the run of backslashes
 * before the key's opening quote (none at the top level, one a level down, three below that)
 * repeats before each later quote of the field. The lookbehind keeps that run whole.
 */
const QUOTED_SECRET_FIELD_RE = new RegExp(
	String.raw`(?<!\\)(\\*)"(?:[A-Za-z0-9]+[-_])*(?:authorization|api[-_]?key|secret|token|password|passwd|pwd)\1"\s*:\s*\1"`,
	'gi',
);

/**
 * Whether `run` backslashes and then a quote close a string whose own quotes carry `depth`
 * backslashes. A level down, every backslash doubles and each quote gains one, so the closing
 * quote has `depth` backslashes after any number of escaped backslashes, each `2 * (depth + 1)`
 * long. Fewer than `depth` belong to an enclosing string, which ends the value too.
 */
const closesQuotedValue = (run: number, depth: number): boolean =>
	run < depth || (run - depth) % (2 * (depth + 1)) === 0;

/** Index where a quoted value that starts at `start` ends, or the end of text if it never does. */
const quotedValueEnd = (text: string, start: number, depth: number): number => {
	for (let index = start; index < text.length; index++) {
		let run = 0;
		while (text[index + run] === '\\') run++;
		if (text[index + run] === '"' && closesQuotedValue(run, depth)) {
			return index + Math.max(0, run - depth);
		}
		index += run;
	}
	return text.length;
};

/**
 * Replaces the string value of every quoted secret field with [REDACTED] and keeps its quotes,
 * so a provider error carrying JSON, or JSON nested inside a JSON string, stays valid and its
 * ordinary keys and values stay readable.
 */
const redactQuotedSecretFields = (message: string): string => {
	let result = '';
	let cursor = 0;
	QUOTED_SECRET_FIELD_RE.lastIndex = 0;
	let match = QUOTED_SECRET_FIELD_RE.exec(message);
	while (match) {
		const valueStart = match.index + match[0].length;
		result += `${message.slice(cursor, valueStart)}[REDACTED]`;
		cursor = quotedValueEnd(message, valueStart, match[1]?.length ?? 0);
		QUOTED_SECRET_FIELD_RE.lastIndex = cursor;
		match = QUOTED_SECRET_FIELD_RE.exec(message);
	}
	return result + message.slice(cursor);
};

/**
 * Sanitizes an error or log message by stripping credentials from URLs and
 * redacting quoted JSON secret fields, authorization headers, bearer tokens,
 * secret key-value pairs, and recognizable provider credentials.
 */
export const sanitizeMessage = (message: string): string => {
	let result = message.replace(EMBEDDED_USERPASS_RE, '$1').replace(EMBEDDED_TOKEN_RE, '$1');
	result = redactQuotedSecretFields(result)
		.replace(AUTHORIZATION_HEADER_RE, '$1[REDACTED]')
		.replace(AUTHORIZATION_VALUE_RE, '$1[REDACTED]')
		.replace(BEARER_TOKEN_RE, '$1[REDACTED]')
		.replace(GENERIC_SECRET_VALUE_RE, '$1[REDACTED]');
	for (const pattern of SECRET_PATTERNS) {
		result = result.replace(pattern, '[REDACTED]');
	}
	return result;
};

// ── GitHub.com host validation ──────────────────────────────────────────────

const GITHUB_COM_HOSTS = new Set(['github.com', 'www.github.com']);

/**
 * Parses the hostname from a Git remote URL (HTTPS or SSH format).
 *
 *   https://github.com/owner/repo.git → github.com
 *   git@github.com:owner/repo.git     → github.com
 *   https://git.internal.com/repo.git → git.internal.com
 */
export const extractHost = (url: string): null | string => {
	const https = url.match(/^https?:\/\/([^/]+)/);
	if (https?.[1]) return https[1].toLowerCase();
	const ssh = url.match(/^git@([^:]+):/);
	if (ssh?.[1]) return ssh[1].toLowerCase();
	const scp = url.match(/^ssh:\/\/git@([^/:]+)/);
	if (scp?.[1]) return scp[1].toLowerCase();
	return null;
};

/**
 * Returns true only if the URL points to GitHub.com (not GitHub Enterprise
 * Server or other hosts).
 */
export const isGitHubDotComUrl = (url: string): boolean => {
	const host = extractHost(url);
	return host !== null && GITHUB_COM_HOSTS.has(host);
};

export const isArchiveHostUrl = (url: string, host: ArchiveHost): boolean =>
	host === 'github.com' ? isGitHubDotComUrl(url) : extractHost(url) === host;

// ── Git auth error detection ────────────────────────────────────────────────

/** Pattern matching common Git authentication/authorization failure messages. */
const GIT_AUTH_ERROR_RE =
	/authentication failed|could not read username|terminal prompts? disabled|returned error: 40[13]|invalid username|permission denied \(.*\)\.|access denied/i;

/** Returns true when a Git error message indicates a credential or authorization problem. */
export const isGitAuthError = (message: string): boolean => GIT_AUTH_ERROR_RE.test(message);

// ── User-facing guidance ────────────────────────────────────────────────────

/**
 * Guidance shown when Git transport authentication fails or when embedded
 * credentials are detected in a remote URL.
 */
export const CREDENTIAL_GUIDANCE =
	'Configure Git Credential Manager (git config --global credential.helper manager) ' +
	'or SSH keys for Git access. StarSync does not embed the API token in Git operations.';
