/**
 * Reading a consumer's own file as text for the reference sweep. UTF-8 is the default. A file that
 * starts with a UTF-16 byte-order mark, as PowerShell 5's `>` redirect writes one, is decoded as
 * UTF-16, so its NUL bytes neither make it look binary nor hide the paths it names (Morticia, L-4 on
 * e1ff196). A NUL anywhere else still marks a binary file, which names no path a lead edits.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';

/** Files larger than this are not read; `unreadFiles` names every text file it leaves out. */
export const MAX_BYTES = 32_000_000;

/** The encoding a file's first two bytes declare: a UTF-16 byte-order mark, or UTF-8 by default. */
function encodingOf(head: Buffer): 'utf16be' | 'utf16le' | 'utf8' {
	if (head[0] === 0xff && head[1] === 0xfe) return 'utf16le';
	if (head[0] === 0xfe && head[1] === 0xff) return 'utf16be';
	return 'utf8';
}

/** The file's bytes as text, without a UTF-16 byte-order mark. */
function decode(bytes: Buffer): string {
	const encoding = encodingOf(bytes);
	if (encoding === 'utf8') return bytes.toString('utf8');
	const body = bytes.subarray(2, bytes.length - (bytes.length % 2));
	return encoding === 'utf16le'
		? body.toString('utf16le')
		: Buffer.from(body).swap16().toString('utf16le');
}

/** Whether a file is binary: its first bytes hold a NUL, and no UTF-16 byte-order mark explains it. */
export function looksBinary(at: string): boolean {
	const head = Buffer.alloc(8192);
	const handle = openSync(at, 'r');
	try {
		const read = head.subarray(0, readSync(handle, head, 0, head.length, 0));
		return encodingOf(read) === 'utf8' && read.includes(0);
	} finally {
		closeSync(handle);
	}
}

/** The text of a file the lead could edit, or null for a binary, oversized or missing one. */
export function readText(at: string): null | string {
	if (!existsSync(at) || statSync(at).size > MAX_BYTES) return null;
	const text = decode(readFileSync(at));
	return text.includes('\0') ? null : text;
}
