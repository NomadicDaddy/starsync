/**
 * A complete, tag-verified delivery can lag the owner without being locally altered.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { existsSync } from 'node:fs';
import { join, posix, relative } from 'node:path';

import type { Finding } from './check.ts';
import type { SharedCoreGroup } from './manifest.ts';
import type { Target } from './targets.ts';

import { gitModes, type GroupState, lockDifferences } from './expected.ts';
import { hookClaim } from './hook.ts';
import { hashShared, isClaim, readLock } from './lock.ts';
import { syncedPathsAt, verifyOrigin } from './origin.ts';
import { readShared } from './owner.ts';

const ancestors = new Map<string, boolean>();

/** A tag held locally can belong to a newer or separate branch, which is not behind this checkout. */
function precedesOwner(ownerRoot: string, commit: string): boolean {
	const key = JSON.stringify([ownerRoot, commit]);
	const cached = ancestors.get(key);
	if (cached !== undefined) return cached;
	const result = Bun.spawnSync(
		['git', '-C', ownerRoot, 'merge-base', '--is-ancestor', commit, 'HEAD'],
		{
			stderr: 'pipe',
			stdout: 'pipe',
			windowsHide: true,
		},
	);
	const before = result.exitCode === 0;
	ancestors.set(key, before);
	return before;
}

export function classifyBehind(
	group: SharedCoreGroup,
	target: Target,
	ownerRoot: string,
	findings: Finding[],
): Finding[] {
	if (!findings.some((finding) => finding.kind === 'drift')) return findings;
	let lock: ReturnType<typeof readLock>;
	try {
		lock = readLock(target.path);
	} catch {
		// lockFindings reports malformed locks; they never qualify for the rollout allowance.
		return findings;
	}
	if (!lock?.version || !lock.commit) return findings;
	const recorded = lock.groups[group.name];
	if (!recorded || verifyOrigin(ownerRoot, lock).state !== 'verified') return findings;
	if (!precedesOwner(ownerRoot, lock.commit)) return findings;
	const paths = syncedPathsAt(ownerRoot, lock.commit)?.get(group.name);
	if (!paths || paths.length !== Object.keys(recorded).length) return findings;
	if (
		paths.some((path) => recorded[path] === undefined || !existsSync(join(target.path, path)))
	) {
		return findings;
	}
	const modes = gitModes(target.path, paths);
	const state: GroupState = {};
	for (const path of paths) {
		const entry = recorded[path];
		if (entry === undefined) return findings;
		if (isClaim(entry)) {
			if (!group.hook || path !== posix.join(group.targetRoot, group.hook)) return findings;
			const claim = hookClaim(group, readShared(join(target.path, path)));
			if (claim === 'ours') return findings;
			state[path] = { claim };
		} else {
			state[path] = {
				mode: modes.get(path) ?? '',
				sha256: hashShared(join(target.path, path)),
			};
		}
	}
	if (lockDifferences(group, recorded, state).length > 0) return findings;
	const identity = `v${lock.version} (${lock.commit.slice(0, 8)})`;
	return findings.map((finding): Finding => {
		if (finding.kind !== 'drift' || finding.destination === undefined) return finding;
		const path = relative(target.path, finding.destination).replaceAll('\\', '/');
		if (!paths.includes(path)) return finding;
		return {
			...finding,
			detail: `${finding.detail}; matches locked tag ${identity}, so delivery is behind`,
			kind: 'behind',
		};
	});
}
