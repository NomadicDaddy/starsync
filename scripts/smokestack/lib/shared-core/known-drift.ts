/**
 * KNOWN DRIFT. A fatal row the owner has already looked at, has a reason for and has given an owner
 * and an end date, so that it stops turning every gate red while it waits on its fix (Phillip,
 * bottleneck item 6). The rows it can name are the drift a target holds and the owner cannot settle
 * from here, such as a repository with no lock that a delivery has not reached yet.
 *
 * Each entry names one row exactly: its repository, its group, its finding kind and its detail, the
 * text the check prints after the repository's name. It also gives the reason, the owner and the
 * date it expires. Until that date, inclusive, the fatal finding with that identity is reported as
 * KNOWN-DRIFT and does not fail the check. Any other row, in the same repository or not, still
 * fails: an entry accepts the row someone looked at, never a class of rows nobody has seen yet. From the next day the row fails again, and the run says
 * which entry ran out. An entry may not expire more than 14 days after the day it is read: a list
 * that could hold a row back indefinitely would be the standing red this exists to end, made quiet.
 *
 * The list names sibling repositories, so like the rosters and frozen-targets.json it is untracked,
 * only its `.example` is tracked, and a branch worktree reads the main checkout's. A missing list
 * means nothing is known, which is the safe reading: every row then fails as it would without it.
 * Only `--check` reads it. A write still replaces a drifted file, known or not.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Finding, type FindingKind, type GroupReport, isFatal } from './check.ts';

export const KNOWN_DRIFT_FILE = 'known-drift.json';
const MAX_DAYS = 14;
const DAY_MS = 86_400_000;

export interface KnownDrift {
	/** The finding's detail exactly as the check prints it, which names the file it is about. */
	detail: string;
	expires: string;
	group: string;
	owner: string;
	reason: string;
	repo: string;
	row: FindingKind;
}

/** Days since the epoch for a YYYY-MM-DD date, or null when it is not one. */
function dayNumber(date: string): null | number {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (match === null) return null;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const time = Date.UTC(year, month - 1, day);
	const back = new Date(time);
	// Date.UTC rolls 2026-02-30 over into March; a date that does not survive the round trip is not one.
	if (back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null;
	return time / DAY_MS;
}

/** This machine's local date as YYYY-MM-DD: the day a person reading the gate would name. */
export function localToday(now: Date = new Date()): string {
	const pad = (n: number): string => String(n).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function text(entry: Record<string, unknown>, key: string, where: string): string {
	const value = entry[key];
	if (typeof value !== 'string' || value.trim() === '') {
		throw new Error(`${where}: "${key}" must be a non-empty string.`);
	}
	return value.trim();
}

/**
 * The list, or [] when this checkout has none. Throws on a list it cannot read, on an entry missing
 * a field, on a row that is not a fatal kind (it could hold nothing back), and on an expiry more than
 * 14 days after `today`.
 */
export function loadKnownDrift(root: string, today: string): KnownDrift[] {
	const path = join(root, KNOWN_DRIFT_FILE);
	if (!existsSync(path)) return [];
	const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
	if (!Array.isArray(parsed)) throw new Error(`${path}: expected an array of entries.`);
	const now = dayNumber(today);
	if (now === null) throw new Error(`today is not a YYYY-MM-DD date: ${today}`);
	return parsed.map((raw: unknown, index) => {
		const where = `${path} entry ${index + 1}`;
		if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
			throw new Error(`${where}: expected an object.`);
		}
		const entry = raw as Record<string, unknown>;
		const row = text(entry, 'row', where);
		if (!isFatal({ detail: '', group: '', kind: row as FindingKind, target: '' })) {
			throw new Error(`${where}: "row" must name a kind that fails the check, not "${row}".`);
		}
		const expires = text(entry, 'expires', where);
		const end = dayNumber(expires);
		if (end === null) throw new Error(`${where}: "expires" must be a YYYY-MM-DD date.`);
		if (end - now > MAX_DAYS) {
			throw new Error(
				`${where}: expires ${expires}, more than ${MAX_DAYS} days after ${today}. Name a ` +
					`date no later than ${MAX_DAYS} days ahead, and renew it then if it still holds.`,
			);
		}
		return {
			detail: text(entry, 'detail', where),
			expires,
			group: text(entry, 'group', where),
			owner: text(entry, 'owner', where),
			reason: text(entry, 'reason', where),
			repo: text(entry, 'repo', where),
			row: row as FindingKind,
		};
	});
}

export interface KnownDriftApplied {
	/** Entries past their date: their rows fail again. */
	expired: KnownDrift[];
	reports: GroupReport[];
	scope: Finding[];
	/** Entries in date that held back no finding: whatever they named is gone, or never matched. */
	unused: KnownDrift[];
}

/**
 * The reports and the lock-scope findings with every fatal row that an entry in date covers turned
 * into a KNOWN-DRIFT finding, which does not fail the check, plus the entries that ran out and the
 * ones that held nothing back.
 */
export function applyKnownDrift(
	reports: GroupReport[],
	scope: Finding[],
	entries: KnownDrift[],
	today: string,
): KnownDriftApplied {
	const now = dayNumber(today) ?? Number.NaN;
	const expired = entries.filter((entry) => (dayNumber(entry.expires) ?? -1) < now);
	const live = entries.filter((entry) => !expired.includes(entry));
	const used = new Set<KnownDrift>();
	const hold = (findings: Finding[]): Finding[] =>
		findings.map((finding) => {
			const entry = live.find(
				(candidate) =>
					candidate.row === finding.kind &&
					candidate.group === finding.group &&
					candidate.detail === finding.detail &&
					candidate.repo.toLowerCase() === finding.target.toLowerCase(),
			);
			if (entry === undefined) return finding;
			used.add(entry);
			const until = `known until ${entry.expires}, owner ${entry.owner}: ${entry.reason}`;
			return { ...finding, detail: `${finding.detail} (${until})`, kind: 'known-drift' };
		});
	return {
		expired,
		reports: reports.map((report) => ({ ...report, findings: hold(report.findings) })),
		scope: hold(scope),
		unused: live.filter((entry) => !used.has(entry)),
	};
}

function rowOf(entry: KnownDrift): string {
	return `${entry.row} entry for ${entry.repo} (${entry.group}: ${entry.detail})`;
}

/** What a check prints about the list itself, after the rows: one line per entry worth a look. */
export function knownDriftLines(applied: KnownDriftApplied): string[] {
	return [
		...applied.expired.map(
			(entry) =>
				`[WARN] ${KNOWN_DRIFT_FILE}: the ${rowOf(entry)} expired on ${entry.expires}, so ` +
				`its row fails again. Owner: ${entry.owner}.`,
		),
		...applied.unused.map(
			(entry) =>
				`[INFO] ${KNOWN_DRIFT_FILE}: the ${rowOf(entry)} held back nothing in this run; ` +
				'remove it once its row is fixed.',
		),
	];
}
