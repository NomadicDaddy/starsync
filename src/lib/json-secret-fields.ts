/**
 * Redaction of secret properties inside JSON carried in error and report text, at any JSON
 * escaping depth, keeping the JSON valid. sanitizeMessage in secret-safety.ts is its one caller.
 */

/**
 * A decoded JSON property name that holds a credential: it ends in one of these words, or its
 * plural, after any prefix, with or without a separator, so access_token, accessToken, tokens,
 * x-api-key, secret_access_key and Set-Cookie all match while tokenType and author do not.
 */
const SECRET_PROPERTY_RE =
	/(?:authorization|auth|(?:api|access|private)[-_]?key|secret|token|password|passwd|pwd|cookie)s?$/i;

/**
 * A double quote and the whole run of backslashes before it. JSON carried inside a JSON string
 * escapes its quotes, so that run (none at the top level, one a level down, three below that)
 * gives the depth, and each later quote of the same field carries the same run.
 */
const QUOTE_RE = /(?<!\\)(\\*)"/g;
const FIELD_SEPARATOR_RE = /\s*:\s*/y;
const JSON_NUMBER_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * Whether `run` backslashes and then a quote close a string whose own quotes carry `depth`
 * backslashes. A level down, every backslash doubles and each quote gains one, so the closing
 * quote has `depth` backslashes after any number of escaped backslashes, each `2 * (depth + 1)`
 * long. Fewer than `depth` belong to an enclosing string, which ends the value too.
 */
const closesQuotedValue = (run: number, depth: number): boolean =>
	run < depth || (run - depth) % (2 * (depth + 1)) === 0;

/** Index where a quoted value that starts at `start` ends, or the end of text if it never does. */
export const quotedValueEnd = (text: string, start: number, depth: number): number => {
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

interface SecretValueSpan {
	end: number;
	replacement: string;
	start: number;
}

/**
 * Index just past the object or array that starts at `start`, or null if it never closes. Strings
 * at the same escaping depth are skipped whole, so a brace or bracket inside one doesn't count.
 */
const structuredValueEnd = (text: string, start: number, depth: number): null | number => {
	let nesting = 0;
	for (let index = start; index < text.length; index++) {
		let run = 0;
		while (text[index + run] === '\\') run++;
		const character = text[index + run];
		if (character === '"' && run === depth) {
			index = quotedValueEnd(text, index + run + 1, depth) + depth;
			continue;
		}
		index += run;
		if (character === '{' || character === '[') nesting++;
		if ((character === '}' || character === ']') && --nesting === 0) return index + 1;
	}
	return null;
};

/**
 * The span of a secret property's value and what replaces it, or null. A string value keeps its
 * quotes and gets [REDACTED] inside them. A number, object or array becomes the quoted string
 * "[REDACTED]" at the field's own depth, so the JSON stays valid and nothing nested under the
 * secret name survives. true, false and null are left alone.
 */
const secretValueSpan = (
	text: string,
	valueStart: number,
	quote: string,
): null | SecretValueSpan => {
	const depth = quote.length - 1;
	const wrapped = `${quote}[REDACTED]${quote}`;
	if (text.startsWith(quote, valueStart)) {
		const start = valueStart + quote.length;
		return { end: quotedValueEnd(text, start, depth), replacement: '[REDACTED]', start };
	}
	if (text[valueStart] === '{' || text[valueStart] === '[') {
		const end = structuredValueEnd(text, valueStart, depth);
		return end === null ? null : { end, replacement: wrapped, start: valueStart };
	}
	JSON_NUMBER_RE.lastIndex = valueStart;
	const number = JSON_NUMBER_RE.exec(text);
	if (number === null) return null;
	return { end: valueStart + number[0].length, replacement: wrapped, start: valueStart };
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
export const redactQuotedSecretFields = (message: string): string => {
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
