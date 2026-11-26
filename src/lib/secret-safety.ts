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

import { quotedValueEnd, redactQuotedSecretFields } from './json-secret-fields.ts';

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

// A quoted value, including one whose quotes are escaped because the text sits inside a JSON
// string. The bare forms below stop at a quote or backslash: credential values never contain
// either, and stopping there keeps a match from running past the end of the JSON string it sits
// in, which would swallow its closing quote and the fields after it.
const QUOTED_TEXT_VALUE = String.raw`"[^"\r\n]*"|'[^'\r\n]*'|\\+"[^"\\\r\n]*\\+"`;

const AUTHORIZATION_HEADER_RE = new RegExp(
	String.raw`(\bauthorization\s*:\s*)(?:${QUOTED_TEXT_VALUE}|[^\r\n"\\]+)`,
	'gi',
);
const AUTHORIZATION_VALUE_RE = new RegExp(
	String.raw`(\bauthorization\s*=\s*)(?:${QUOTED_TEXT_VALUE}|[^\s&#,;"\\]+)`,
	'gi',
);
const BEARER_TOKEN_RE = new RegExp(
	String.raw`(\bbearer\s+)(?:${QUOTED_TEXT_VALUE}|[^\s,;"\\]+)`,
	'gi',
);
// The lookaheads leave a JSON value the quoted-field pass already redacted, and a complete JSON
// true, false or null (one a delimiter or the end follows), as they are, so the JSON stays valid
// instead of losing a value's quotes or gaining an unquoted word. A credential that merely begins
// with one of those words is still redacted.
const GENERIC_SECRET_VALUE_RE = new RegExp(
	String.raw`((?:["']?)(?:(?:[A-Za-z0-9]+[-_])*(?:api[-_]?key|secret|token|password|passwd|pwd))["']?\s*(?:=|:)\s*)(?!"\[REDACTED\]")(?!(?:true|false|null)\s*(?:[,}\]]|$))(?:${QUOTED_TEXT_VALUE}|[^\s&#,;"\\]+)`,
	'gi',
);

/**
 * Sanitizes one JSON string literal by its decoded text, so escapes such as a tab or a newline
 * read as the characters they stand for and every rule sees the text a reader would. The literal
 * is re-encoded only when something was redacted; otherwise its original spelling is kept.
 */
const sanitizeStringLiteral = (raw: string): string => {
	let decoded: unknown;
	try {
		decoded = JSON.parse(raw);
	} catch {
		return raw;
	}
	if (typeof decoded !== 'string') return raw;
	const cleaned = sanitizeMessage(decoded);
	return cleaned === decoded ? raw : JSON.stringify(cleaned);
};

/**
 * Applies the whole sanitizer inside each top-level JSON string literal, which reaches JSON
 * nested inside a string level by level. The quote pattern is local because this recurses.
 */
const sanitizeStringLiterals = (message: string): string => {
	const quotes = /(?<!\\)"/g;
	let result = '';
	let copied = 0;
	for (let quote = quotes.exec(message); quote; quote = quotes.exec(message)) {
		const end = quotedValueEnd(message, quote.index + 1, 0);
		if (end >= message.length) break;
		const raw = message.slice(quote.index, end + 1);
		const cleaned = sanitizeStringLiteral(raw);
		if (cleaned !== raw) {
			result += message.slice(copied, quote.index) + cleaned;
			copied = end + 1;
		}
		quotes.lastIndex = end + 1;
	}
	return result + message.slice(copied);
};

/**
 * Sanitizes an error or log message by stripping credentials from URLs and
 * redacting quoted JSON secret fields, authorization headers, bearer tokens,
 * secret key-value pairs, and recognizable provider credentials, both in the
 * text as written and inside each JSON string literal by its decoded text.
 */
export const sanitizeMessage = (message: string): string => {
	let result = message.replace(EMBEDDED_USERPASS_RE, '$1').replace(EMBEDDED_TOKEN_RE, '$1');
	result = sanitizeStringLiterals(redactQuotedSecretFields(result))
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
