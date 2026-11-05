import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { GroupReport } from './check.ts';

const GROUP = 'test-timeout-preload';
const PRELOAD = 'scripts/smokestack/test-timeout.ts';

function alreadyPreloaded(root: string): boolean {
	const path = join(root, 'bunfig.toml');
	if (!existsSync(path)) return false;
	try {
		const parsed: unknown = Bun.TOML.parse(readFileSync(path, 'utf8'));
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
		const test = (parsed as Record<string, unknown>)['test'];
		if (test === null || typeof test !== 'object' || Array.isArray(test)) return false;
		const preload = (test as Record<string, unknown>)['preload'];
		return (
			Array.isArray(preload) &&
			preload.some(
				(value: unknown) =>
					typeof value === 'string' &&
					resolve(root, value.replaceAll('\\', '/')) === join(root, PRELOAD),
			)
		);
	} catch {
		return false;
	}
}

/** The consumer's bunfig is lead-owned; the delivery only tells its lead what to add. */
export function testTimeoutLeadLines(reports: GroupReport[], fleetRoot: string): string[] {
	const report = reports.find((entry) => entry.group === GROUP);
	if (report === undefined) return [];
	return report.reached
		.filter((directory) => !alreadyPreloaded(join(fleetRoot, directory)))
		.sort()
		.map(
			(directory) =>
				`LEAD ${directory}: add "./${PRELOAD}" to bunfig.toml [test].preload, ` +
				'preserving any existing entries',
		);
}
