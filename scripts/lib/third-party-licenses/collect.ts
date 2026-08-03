/**
 * Resolves third-party license data from the installed dependency graph.
 *
 * Two sets are collected:
 * - Direct production dependencies, enumerated with version and license.
 * - Their transitive closure, resolved from bun.lock and summarized as a license distribution, so
 *   a non-permissive license anywhere beneath a declared dependency is visible.
 *
 * StarSync is a single package with no workspaces. The sibling repositories this generator came
 * from thread a workspace list through every collector; that parameter is absent here rather than
 * carried around as a permanently empty array.
 */

import { join } from 'node:path';

import { licenseOf, readJson, workspaceNames } from '../license-core/manifest.ts';

export { licenseOf } from '../license-core/manifest.ts';

export interface DirectDependency {
	license: string;
	name: string;
	version: string;
}

export interface GraphSummary {
	distribution: { count: number; license: string }[];
	flagged: { license: string; name: string }[];
	uniqueNames: number;
	uniqueVersions: number;
}

/** The package's own name, so the closure walk never treats this repository as a dependency. */
export async function internalNames(root: string): Promise<Set<string>> {
	return await workspaceNames(root, []);
}

export async function collectDirectDependencies(
	root: string,
): Promise<{ dependencies: DirectDependency[]; unresolved: string[] }> {
	const internal = await internalNames(root);
	const manifest = await readJson(join(root, 'package.json'));
	const declared = manifest?.dependencies;
	if (typeof declared !== 'object' || declared === null) {
		return { dependencies: [], unresolved: [] };
	}

	const dependencies: DirectDependency[] = [];
	const unresolved: string[] = [];

	for (const name of Object.keys(declared as Record<string, unknown>).sort()) {
		if (internal.has(name)) continue;

		const installed = await readJson(join(root, 'node_modules', name, 'package.json'));
		if (!installed) {
			unresolved.push(name);
			continue;
		}
		dependencies.push({
			license: licenseOf(installed),
			name,
			version: String(installed.version ?? '?'),
		});
	}

	return { dependencies, unresolved };
}
