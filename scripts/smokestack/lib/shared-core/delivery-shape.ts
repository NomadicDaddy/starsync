/**
 * The shape of deliveries.json's entries, checked on every read and put in one written form on
 * every write: a confirmed delivery (`roots`) and a delivery into a linked worktree still pending
 * in its canonical checkout (`pending`, pending.ts). Both maps are validated in full wherever the
 * record is read, so no write carries a malformed entry through unseen (Roger, 95427f3).
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import type { DeliveredGroup, DeliveredTarget } from './deliveries.ts';

/** One delivery into a linked worktree: the confirmed shape plus the checkout and branch written. */
export interface PendingDelivery extends DeliveredTarget {
	branch: string;
	checkout: string;
}

/** By canonical root key, then directory: every pending delivery, one per checkout. */
export type PendingRecord = Record<string, Record<string, PendingDelivery[]>>;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One recorded delivery, checked field by field; throws naming `where`. */
export function asTarget(raw: unknown, where: string): DeliveredTarget {
	const fail = (message: string): never => {
		throw new Error(`${where} ${message}`);
	};
	if (!isRecord(raw)) return fail('must be an object.');
	const { commit, groups, version } = raw;
	if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit)) {
		return fail('commit must be 40 hex characters.');
	}
	if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)) {
		return fail('version must be three numbers, as in 1.2.3.');
	}
	if (!isRecord(groups)) return fail('groups must be an object.');
	const read: DeliveredTarget['groups'] = {};
	for (const [name, group] of Object.entries(groups)) {
		if (!isRecord(group)) return fail(`group '${name}' must be an object.`);
		const { claim, paths } = group;
		if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) {
			return fail(`group '${name}' paths must be a list of paths.`);
		}
		if (claim !== undefined && claim !== 'foreign-hook' && claim !== 'local-chain') {
			return fail(`group '${name}' claim is not one a write records.`);
		}
		read[name] = { paths: paths as string[], ...(claim === undefined ? {} : { claim }) };
	}
	return { commit, groups: read, version };
}

function asPending(raw: unknown, where: string): PendingDelivery {
	if (!isRecord(raw)) throw new Error(`${where} must be an object.`);
	const { branch, checkout } = raw;
	if (typeof checkout !== 'string' || checkout === '') {
		throw new Error(`${where} checkout must name the checkout written.`);
	}
	if (typeof branch !== 'string' || branch === '') {
		throw new Error(`${where} branch must name the branch written.`);
	}
	return { ...asTarget(raw, where), branch, checkout };
}

/** The whole `pending` map, checked in full. Throws on any entry it cannot vouch for. */
export function readPendingMap(raw: unknown, path: string): PendingRecord {
	if (!isRecord(raw)) throw new Error(`${path}: pending must be an object.`);
	const read: PendingRecord = {};
	for (const [root, section] of Object.entries(raw)) {
		if (!isRecord(section)) throw new Error(`${path}: pending ${root} must be an object.`);
		const directories: Record<string, PendingDelivery[]> = {};
		for (const [directory, list] of Object.entries(section)) {
			const where = `${path}: pending ${directory} under ${root}`;
			if (!Array.isArray(list)) throw new Error(`${where} must be a list.`);
			directories[directory] = list.map((entry, i) =>
				asPending(entry, `${where} [${String(i)}]`),
			);
		}
		read[root] = directories;
	}
	return read;
}

function writtenGroups(groups: Record<string, DeliveredGroup>): Record<string, unknown> {
	return Object.fromEntries(
		Object.keys(groups)
			.sort()
			.map((name) => {
				const group = groups[name] ?? { paths: [] };
				const claim = group.claim === undefined ? {} : { claim: group.claim };
				return [name, { ...claim, paths: [...group.paths].sort() }];
			}),
	);
}

/** The written form of `pending`: keys sorted, lists by checkout, empty sections dropped. */
export function writtenPending(record: PendingRecord): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const root of Object.keys(record).sort()) {
		const section: Record<string, unknown> = {};
		for (const directory of Object.keys(record[root] ?? {}).sort()) {
			const list = [...(record[root]?.[directory] ?? [])].sort((a, b) =>
				a.checkout.localeCompare(b.checkout),
			);
			if (list.length === 0) continue;
			section[directory] = list.map((entry) => ({
				branch: entry.branch,
				checkout: entry.checkout,
				commit: entry.commit,
				groups: writtenGroups(entry.groups),
				version: entry.version,
			}));
		}
		if (Object.keys(section).length > 0) out[root] = section;
	}
	return out;
}
