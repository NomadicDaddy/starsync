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
// The lookaheads leave a JSON value the quoted-field pass already redacted, and a JSON true, false
// or null, as they are, so the JSON stays valid instead of losing a value's quotes or gaining an
// unquoted word.
const GENERIC_SECRET_VALUE_RE = new RegExp(
	String.raw`((?:["']?)(?:(?:[A-Za-z0-9]+[-_])*(?:api[-_]?key|secret|token|password|passwd|pwd))["']?\s*(?:=|:)\s*)(?!"\[REDACTED\]")(?!(?:true|false|null)\b)(?:${QUOTED_TEXT_VALUE}|[^\s&#,;"\\]+)`,
	'gi',
);

/**
 * A decoded JSON property name that holds a credential: it ends in one of these words after any
 * prefix, with or without a separator, so access_token, accessToken, x-api-key, secret_access_key
 * and Set-Cookie all match while tokenType and author do not.
 */
const SECRET_PROPERTY_RE =
	/(?:authorization|auth|(?:api|access|private)[-_]?key|secret|token|password|passwd|pwd|cookie)$/i;

/**
 * A double quote and the whole run of backslashes before it. JSON carried inside a JSON string
 * escapes its quotes, so that run (none at the top level, one a level down, three below that)
 * gives the depth, and each later quote of the same field carries the same run.
 */
const QUOTE_RE = /(?<!\\)(\\*)"/g;
const FIELD_SEPARATOR_RE = /\s*:\s*/y;

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
 * Decodes a property name written where quotes carry `depth` backslashes, one JSON string decode
 * per level, so a name spelled with JSON unicode escapes (a backslash, u and four hex digits) is
 * matched as the name it stands for. Returns null for text that isn't a valid name at that depth.
 */
const decodePropertyName = (raw: string, depth: number): null | string => {
	const levels = Math.log2(depth + 1);
	if (!Number.isInteger(levels)) return null;
	let name = raw;
	try {
		for (let level = 0; level <= levels; level++) {
			const decoded: unknown = JSON.parse(`"${name}"`);
			if (typeof decoded !== 'string') return null;
			name = decoded;
		}
	} catch {
		return null;
	}
	return name;
};

const JSON_NUMBER_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

interface SecretValueSpan {
	end: number;
	replacement: string;
	start: number;
}

/**
 * The span of a secret property's value and what replaces it, or null. A string value keeps its
 * quotes and gets [REDACTED] inside them. A number becomes the quoted string "[REDACTED]" at the
 * field's own depth, so the JSON stays valid. true, false and null are left alone.
 */
const secretValueSpan = (
	text: string,
	valueStart: number,
	quote: string,
): null | SecretValueSpan => {
	if (text.startsWith(quote, valueStart)) {
		const start = valueStart + quote.length;
		const depth = quote.length - 1;
		return { end: quotedValueEnd(text, start, depth), replacement: '[REDACTED]', start };
	}
	JSON_NUMBER_RE.lastIndex = valueStart;
	const number = JSON_NUMBER_RE.exec(text);
	if (number === null) return null;
	const end = valueStart + number[0].length;
	return { end, replacement: `${quote}[REDACTED]${quote}`, start: valueStart };
};

/** The value span of a secret property whose quoted name starts at `nameStart`, or null. */
const secretFieldValue = (
	text: string,
	nameStart: number,
	depth: number,
): null | SecretValueSpan => {
	const quote = `${'\\'.repeat(depth)}"`;
	const nameEnd = quotedValueEnd(text, nameStart, depth);
	if (!text.startsWith(quote, nameEnd)) return null;
	FIELD_SEPARATOR_RE.lastIndex = nameEnd + quote.length;
	if (FIELD_SEPARATOR_RE.exec(text) === null) return null;
	const valueStart = FIELD_SEPARATOR_RE.lastIndex;
	const name = decodePropertyName(text.slice(nameStart, nameEnd), depth);
	if (name === null || !SECRET_PROPERTY_RE.test(name)) return null;
	return secretValueSpan(text, valueStart, quote);
};

/**
 * Replaces the string value of every secret property with [REDACTED] and keeps its quotes, so a
 * provider error carrying JSON, or JSON nested inside a JSON string, stays valid and its ordinary
 * keys and values stay readable. Every quote is tried as the start of a name, so a misread pairing
 * can only redact more, and the scan continues inside strings to reach nested JSON.
 */
const redactQuotedSecretFields = (message: string): string => {
	let result = '';
	let copied = 0;
	QUOTE_RE.lastIndex = 0;
	for (let quote = QUOTE_RE.exec(message); quote; quote = QUOTE_RE.exec(message)) {
		const depth = quote[1]?.length ?? 0;
		const field = secretFieldValue(message, quote.index + depth + 1, depth);
		if (field === null) continue;
		result += `${message.slice(copied, field.start)}${field.replacement}`;
		copied = field.end;
		QUOTE_RE.lastIndex = field.end;
	}
	return result + message.slice(copied);
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
