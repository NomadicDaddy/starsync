/**
 * `old-path`: a reference left pointing at where a group used to be installed.
 *
 * Once a target's lock records a group where the manifest installs it, the write has moved that
 * group's files and removed their old copies (move.ts). The write also rewrites a package.json
 * script naming an old path once; a script naming it twice is refused and left for the lead to
 * rewrite. A script still naming an old path then runs a file that is no longer there, and a hook
 * still naming one chains a guard that is no longer there. Either is fatal, like a lost delivery,
 * and so is an old copy still on disk, which nothing will remove once the lock stops naming it.
 *
 * An old path is one a tagged release of this repository installed the group at, which the
 * manifest no longer installs at, and which ends with a file's `source`, the same pairing the
 * write moves by. Read from history, because by the time this is asked the lock no longer records
 * it. Only package.json scripts and the owner's delivered hooks are read: a consumer's own
 * imports, configs and documents are its lead's to change in the delivery commit.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Finding } from './check.ts';
import type { Target } from './targets.ts';

import { installedPath } from './lock.ts';
import { loadManifest, type SharedCoreGroup } from './manifest.ts';
import { pathPattern } from './move.ts';
import { taggedPaths } from './origin.ts';
import { readScripts } from './targets.ts';

/** Each old installed path of `group`, with the path the manifest installs that file at now. */
export function oldPaths(group: SharedCoreGroup, ownerRoot: string): Map<string, string> {
	const now = new Map(group.files.map((file) => [installedPath(group, file), file]));
	const moved = new Map<string, string>();
	for (const path of taggedPaths(ownerRoot, group.name)) {
		if (now.has(path)) continue;
		for (const [to, file] of now) {
			if (path === file.source || path.endsWith(`/${file.source}`)) moved.set(path, to);
		}
	}
	return moved;
}

/** The old-path findings for one group in one target whose lock records it at the new layout. */
export function oldPathFindings(
	group: SharedCoreGroup,
	target: Target,
	ownerRoot: string,
): Finding[] {
	const moved = oldPaths(group, ownerRoot);
	if (moved.size === 0) return [];
	const finding = (detail: string): Finding => ({
		detail,
		group: group.name,
		kind: 'old-path',
		target: target.directory,
	});
	const findings: Finding[] = [];
	const named = (text: string, where: string): void => {
		for (const [from, to] of moved) {
			if (pathPattern(from).test(text)) {
				findings.push(
					finding(`${where} names ${from}, which this release installs at ${to}`),
				);
			}
		}
	};
	// The write records the new paths before it removes the old copies, so a run that stopped
	// between the two leaves copies no later write removes: the lock no longer names them.
	for (const [from, to] of moved) {
		if (existsSync(join(target.path, from))) {
			findings.push(finding(`${from} is still here, and this release installs it at ${to}`));
		}
	}
	for (const [script, value] of Object.entries(readScripts(target.path) ?? {})) {
		named(value, `package.json script ${script}`);
	}
	for (const path of hookPaths(ownerRoot)) {
		if (existsSync(join(target.path, path))) {
			named(readFileSync(join(target.path, path), 'utf8'), `the delivered hook ${path}`);
		}
	}
	return findings;
}

/**
 * Every hook a group of the owner's manifest installs, by installed path. Every group's, not only
 * the moved one's: the hooks stay in .githooks in groups of their own, and chain guards from the
 * groups that move.
 */
function hookPaths(ownerRoot: string): string[] {
	const known = hooksOf.get(ownerRoot);
	if (known !== undefined) return known;
	const paths = loadManifest(join(ownerRoot, 'scripts')).flatMap((group) => {
		const hook = group.files.find((file) => (file.target ?? file.source) === group.hook);
		return hook === undefined ? [] : [installedPath(group, hook)];
	});
	hooksOf.set(ownerRoot, paths);
	return paths;
}

/** The owner's manifest does not change while one sweep runs, so its hooks are read once. */
const hooksOf = new Map<string, string[]>();
