/**
 * `old-path`: a reference left pointing at where a group used to be installed.
 *
 * Once a target's lock records a group where the manifest installs it, the write has moved that
 * group's files and removed their old copies (move.ts). The write also rewrites a package.json
 * script naming an old path once; a script naming it twice is refused and left for the lead to
 * rewrite. A script still naming an old path then runs a file that is no longer there, and a hook
 * still naming one chains a guard that is no longer there. Either is fatal, like a lost delivery,
 * and so is an old copy still on disk, which nothing will remove once the lock stops naming it.
 * So is a clone still dispatching from the folder the hooks left: git runs no delivered hook there.
 *
 * An old path is one a tagged release of this repository installed the group at, which the
 * manifest no longer installs at, and which ends with a file's `source`, the same pairing the
 * write moves by. Read from history, because by the time this is asked the lock no longer records
 * it. package.json scripts, the owner's delivered hooks and the repository's own hooks they run are
 * read in full. A consumer's own imports, configs and documents are its lead's to change in the
 * delivery commit, and the write lists every one (references.ts); of those, only a relative import
 * that resolves to an old path no longer on disk is a finding here, because it cannot typecheck.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import type { Finding } from './check.ts';
import type { Target } from './targets.ts';

import { hooksPath, namesTargetRoot, runByGit } from './dispatch.ts';
import { installedPath } from './lock.ts';
import { loadManifest, type SharedCoreGroup } from './manifest.ts';
import { pathPattern } from './move-scripts.ts';
import { taggedPaths } from './origin.ts';
import { brokenImports, unreadFiles } from './references.ts';
import { readScripts } from './targets.ts';

/**
 * Where a repository keeps hooks of its own, which the delivered hooks run after theirs. A file
 * there carrying this line is a delivered copy, not the repository's own: the hooks skip it too.
 */
const OWN_HOOKS = '.githooks';
const OWNERSHIP_LINE = 'smokestack owns this file';

/** What v0.5.7 kept at a repository's root that the runner now reads from scripts/smokestack/. */
const RUNNER_GROUP = 'runner';
const PREVIOUS_CONFIG_FILE = 'smokestack.json';
const RUNNER_ENTRY = 'scripts/smokestack/smokestack.ts';

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

/** Whether the file at `path` is the repository's own rather than a copy smokestack delivered. */
function isOwn(path: string): boolean {
	return !readFileSync(path, 'utf8').includes(OWNERSHIP_LINE);
}

/** The old-path findings for one group in one target whose lock records it at the new layout. */
export function oldPathFindings(
	group: SharedCoreGroup,
	target: Target,
	ownerRoot: string,
): Finding[] {
	const finding = (detail: string): Finding => ({
		detail,
		group: group.name,
		kind: 'old-path',
		target: target.directory,
	});
	const findings: Finding[] = [];
	// Only a runner installed in scripts/smokestack/ reads its config there (config.ts).
	const readsHome =
		group.name === RUNNER_GROUP &&
		group.files.some((file) => installedPath(group, file) === RUNNER_ENTRY);
	if (readsHome && existsSync(join(target.path, PREVIOUS_CONFIG_FILE))) {
		findings.push(
			finding(
				`${PREVIOUS_CONFIG_FILE} is still at the root, and the runner reads ` +
					`scripts/smokestack/${PREVIOUS_CONFIG_FILE}`,
			),
		);
	}
	const moved = oldPaths(group, ownerRoot);
	if (moved.size === 0) return findings;
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
	// between the two leaves copies no later write removes: the lock no longer names them. A hook
	// at an old path that is the repository's own is not a copy: the delivered hook runs it.
	for (const [from, to] of moved) {
		const at = join(target.path, from);
		if (!existsSync(at) || (group.hook !== undefined && isOwn(at))) continue;
		findings.push(finding(`${from} is still here, and this release installs it at ${to}`));
	}
	if (group.hook !== undefined) {
		const configured = hooksPath(target.path);
		const folders = new Set([...moved.keys()].map((from) => posix.dirname(from)));
		for (const folder of folders) {
			if (!namesTargetRoot(target.path, configured, folder)) continue;
			findings.push(
				finding(
					`core.hooksPath is ${configured}, so git runs no hook from ` +
						`${group.targetRoot}, where this release installs them`,
				),
			);
		}
	}
	for (const [script, value] of Object.entries(readScripts(target.path) ?? {})) {
		named(value, `package.json script ${script}`);
	}
	if (moved.size > 0) {
		for (const unread of unreadFiles(target.path)) {
			findings.push(finding(`${unread}, so its imports of moved paths were not checked`));
		}
	}
	for (const imported of brokenImports(target.path, moved)) {
		findings.push(
			finding(
				`${imported.file}:${String(imported.line)} imports ${imported.from}, ` +
					`which this release installs at ${imported.to}`,
			),
		);
	}
	for (const path of hookPaths(ownerRoot)) {
		const at = join(target.path, path);
		if (existsSync(at)) named(readFileSync(at, 'utf8'), `the delivered hook ${path}`);
	}
	for (const name of group.files.map((file) => file.target ?? file.source)) {
		const at = join(target.path, OWN_HOOKS, name);
		if (!runByGit(group, name) || !existsSync(at) || !isOwn(at)) continue;
		named(readFileSync(at, 'utf8'), `this repository's own hook ${OWN_HOOKS}/${name}`);
	}
	return findings;
}

/**
 * Every hook a group of the owner's manifest installs, by installed path. Every group's, not only
 * the moved one's: a hook in one group chains guards from another.
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
