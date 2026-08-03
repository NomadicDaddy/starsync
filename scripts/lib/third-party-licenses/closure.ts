/**
 * Resolves the runtime closure: every third-party package version bun.lock resolves, transitively,
 * for the declared production dependencies, together with the license text each package ships.
 *
 * The direct-dependency table answers "what did we choose"; this answers "what does an install of
 * StarSync actually put on disk". The published bundle is built with `--packages=external`, so the
 * consumer's package manager installs this whole closure rather than receiving it inside the
 * tarball, and `bun run compile` embeds it into a single-file executable. Either way the
 * obligations reach the transitive graph, not only the package named in package.json.
 *
 * Membership comes from the lockfile alone; the installed tree only supplies each resolved
 * package's own LICENSE/NOTICE text, and a lockfile-resolved package that is not installed fails
 * the generator loudly. This keeps membership independent of stale or duplicate packages in the
 * physical node_modules store.
 *
 * License text is read from each package's own LICENSE/NOTICE file rather than synthesized from
 * its SPDX id, because attribution requires the package's own copyright line, which an SPDX id
 * does not carry.
 *
 * Lockfile parsing lives in license-core/lockfile.ts; locating installed files lives in resolve.ts.
 */

import { join } from 'node:path';

import { collectLockfileClosure, type LockedPackage } from '../license-core/lockfile.ts';
import { byCodepoint } from '../license-core/order.ts';
import { licenseOf } from './collect.ts';
import { readJson, readLicenseText, readNoticeText, resolveVersionedDir } from './resolve.ts';

export interface ClosurePackage {
	license: string;
	/** Verbatim contents of the package's LICENSE file, when it ships one. */
	licenseText: null | string;
	name: string;
	/** Verbatim NOTICE file (Apache-2.0 requires these attributions to be passed on). */
	noticeText: null | string;
	version: string;
}

export async function collectRuntimeClosure(
	root: string,
	internal: ReadonlySet<string>,
): Promise<{ closure: ClosurePackage[]; unresolved: string[] }> {
	const locked = await collectLockfileClosure(root, {
		internal,
		rootFields: ['dependencies'],
		workspaces: [''],
	});
	const seen = new Map<string, ClosurePackage>();
	const unresolved = new Set(locked.unresolved);
	for (const pkg of locked.packages) {
		await record(root, pkg, { seen, unresolved });
	}

	const closure = [...seen.values()].sort(
		(a, b) => byCodepoint(a.name, b.name) || byCodepoint(a.version, b.version),
	);
	return { closure, unresolved: [...unresolved].sort(byCodepoint) };
}

async function record(
	root: string,
	pkg: LockedPackage,
	state: { seen: Map<string, ClosurePackage>; unresolved: Set<string> },
): Promise<void> {
	const key = `${pkg.name}@${pkg.version}`;
	if (state.seen.has(key)) return;

	const dir = await resolveVersionedDir(root, [], pkg.name, pkg.version);
	const manifest = dir === null ? null : await readJson(join(dir, 'package.json'));
	if (dir === null || manifest === null) {
		// The lockfile says an install resolves this exact version, so its license text must be
		// readable here; a missing install is a hole in the attribution, not a detail to skip.
		state.unresolved.add(`${key} (not installed; run bun install)`);
		return;
	}

	state.seen.set(key, {
		license: licenseOf(manifest),
		licenseText: await readLicenseText(dir),
		name: pkg.name,
		noticeText: await readNoticeText(dir),
		version: pkg.version,
	});
}

/**
 * License distribution over the runtime closure.
 *
 * Deterministic: membership is resolved from bun.lock, so the summary depends on the lockfile and
 * manifests rather than unrelated packages installed in node_modules.
 */
export function summarizeClosure(closure: ClosurePackage[]): {
	distribution: { count: number; license: string }[];
	flagged: { license: string; name: string }[];
	uniqueNames: number;
	uniqueVersions: number;
} {
	const counts = new Map<string, number>();
	for (const pkg of closure) counts.set(pkg.license, (counts.get(pkg.license) ?? 0) + 1);

	return {
		distribution: [...counts.entries()]
			.map(([license, count]) => ({ count, license }))
			.sort((a, b) => b.count - a.count || byCodepoint(a.license, b.license)),
		flagged: closure
			.filter((pkg) => /GPL|SSPL|EUPL|CDDL|OSL|MPL/i.test(pkg.license))
			.map((pkg) => ({ license: pkg.license, name: `${pkg.name}@${pkg.version}` }))
			.sort((a, b) => byCodepoint(a.name, b.name)),
		uniqueNames: new Set(closure.map((pkg) => pkg.name)).size,
		uniqueVersions: closure.length,
	};
}

/** Packages that ship no license file: attribution has to be sourced by hand. */
export function packagesWithoutLicenseText(closure: ClosurePackage[]): ClosurePackage[] {
	return closure.filter((pkg) => pkg.licenseText === null);
}
