/**
 * Schema and loader for scripts/shared-core-manifest.json.
 *
 * The manifest describes files that one repository OWNS and other repositories CARRY. It replaces
 * three hand-written installers whose file lists were each restated in a different place. The
 * schema below documents every field locally so a carrier does not depend on sibling documentation.
 *
 * The loader rejects rather than repairs. A manifest that does not describe reality is worse than
 * no manifest, because a sync reports coverage either way — that failure has now been paid for
 * three times in this fleet (a scan root naming a directory no app has, an ignore entry for a
 * directory that was never created, and a hook chaining a guard its installer did not deliver).
 * Two of those failed open and read as coverage while covering nothing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Overwrite to match the owner, or write once and never touch again. There is no third.
 *
 * A reader who meets a target legitimately holding a NEWER copy of an owner-owned file will want to
 * add 'backport-candidate'. Do not. That state is real and has been observed twice, but the channel
 * that has it — template drift into derived apps — already expresses it through `.templateoverrides`,
 * with a deletion condition attached, and this sync does not target derived apps at all. A third
 * disposition here would be double governance, and the concrete failure it invites is a `--check`
 * that reads an authorized temporary divergence as a violation and pressures someone into reverting
 * a fix. The two supported dispositions keep temporary template divergence out of this contract.
 */
export type Disposition = 'seeded' | 'synced';

export interface SharedCoreFile {
	disposition: Disposition;
	/** Installed at the same target when requiresScripts is unmet. */
	fallbackSource?: string;
	/** package.json script names the target must define for `source` to be installable. */
	requiresScripts?: string[];
	/** Relative to the group's sourceRoot, inside the owning repository. */
	source: string;
	/** Relative to the group's targetRoot. Defaults to `source`. */
	target?: string;
}

export interface RosterTargets {
	model: 'roster';
	/** A gitignored file in the owning repository. Never a list of repository names in tracked code. */
	roster: string;
}

export interface DiscoveredTargets {
	/**
	 * A path whose presence in a sibling repository marks it as a target, or ABSENT for every
	 * sibling git repository.
	 *
	 * A discovered group's predicate must be the one its installer already sweeps by, or the gate
	 * verifies a different population than the thing it is verifying. `install-history-guard.ts`
	 * sweeps repositories carrying `.aidd`; `install-leak-guard.ts` sweeps every git repository
	 * under the fleet root and takes no marker at all. Scoping the leak-guard groups to `.aidd`
	 * made the gate blind to nineteen repositories the installer had already covered — it reported
	 * thirty-two current out of fifty-one, and read as full coverage. Recorded as punchlist C5.
	 *
	 * The tempting alternative is a marker naming the guard itself. Do not: that predicate is the
	 * outcome, so `uncovered` becomes unreachable for anything it selects, and the gate would go
	 * green on a fleet where the guard is missing everywhere.
	 */
	marker?: string;
	model: 'discovered';
}

export interface SharedCoreGroup {
	files: SharedCoreFile[];
	/**
	 * The one file in `files` that git dispatches. Written only where core.hooksPath resolves to
	 * targetRoot; elsewhere the guards still install and dispatch is reported as unmanaged.
	 */
	hook?: string;
	/**
	 * A string the hook body contains iff it is ours. A hook WITHOUT it belongs to someone else,
	 * and core.hooksPath allows exactly one of each name, so overwriting it disables whatever was
	 * there. Foreign is reported and never treated as drift.
	 */
	hookMarker?: string;
	/**
	 * A string a target puts in the hook to declare it hand-maintained. Honoring this is not
	 * politeness: a repository with real local checks chained around the guard is CORRECT, and a
	 * check that calls it drift pressures someone into reverting working code. One repository in
	 * this fleet uses it today, chaining leak-guard.sh plus its own lint and format gates.
	 */
	localChainMarker?: string;
	name: string;
	/** Required. Never defaulted, and never inferred from the working directory. */
	owner: string;
	requiresPackageJson?: boolean;
	sourceRoot: string;
	targetRoot: string;
	targets: DiscoveredTargets | RosterTargets;
	/**
	 * Script name to a substring that script must contain. This is reported and never written.
	 * Substring rather than equality because the canonical command is the smallest thing that has
	 * to happen, not the whole of what a target's script may legitimately do. Two carriers proved
	 * that: one composes the guard's setup into a longer `prepare` that also runs its Bun check and
	 * its build, and one dispatches hooks through simple-git-hooks instead of `core.hooksPath` and
	 * still seeds the pattern file. Both satisfy the contract, and an equality test reported both
	 * identically to a repository that had never wired anything. What each substring must name is
	 * therefore the load-bearing invocation alone. `prepare` names only the setup script; whether
	 * dispatch reaches .githooks is a separate question, already answered by the dispatch check.
	 */
	wiring?: Record<string, string>;
}

const OWNERS = new Set(['aidd', 'spernakit']);

function fail(message: string): never {
	throw new Error(`shared-core-manifest.json: ${message}`);
}

function asFile(raw: unknown, where: string): SharedCoreFile {
	if (raw === null || typeof raw !== 'object') fail(`${where} must be an object.`);
	const file = raw as Record<string, unknown>;
	const source = file['source'];
	if (typeof source !== 'string' || source.length === 0) {
		fail(`${where} needs a non-empty source.`);
	}
	const disposition = file['disposition'];
	if (disposition !== 'seeded' && disposition !== 'synced') {
		fail(`${where} disposition must be 'seeded' or 'synced'.`);
	}

	// Both halves or neither. A fallbackSource with no predicate can never be selected, and a
	// predicate with no fallback turns an unmet contract into a silent skip rather than a lesser
	// install — which is how a repository ends up with a hook calling a script it does not define,
	// failing every commit instead of guarding it.
	const requiresScripts = file['requiresScripts'];
	const fallbackSource = file['fallbackSource'];
	if ((requiresScripts === undefined) !== (fallbackSource === undefined)) {
		fail(`${where} must declare requiresScripts and fallbackSource together, or neither.`);
	}
	if (requiresScripts !== undefined) {
		if (
			!Array.isArray(requiresScripts) ||
			requiresScripts.length === 0 ||
			requiresScripts.some((s) => typeof s !== 'string')
		) {
			fail(`${where} requiresScripts must be a non-empty array of script names.`);
		}
		if (typeof fallbackSource !== 'string' || fallbackSource.length === 0) {
			fail(`${where} fallbackSource must be a non-empty string.`);
		}
	}

	const target = file['target'];
	if (target !== undefined && (typeof target !== 'string' || target.length === 0)) {
		fail(`${where} target must be a non-empty string when present.`);
	}

	return {
		disposition,
		source,
		...(typeof target === 'string' ? { target } : {}),
		...(requiresScripts === undefined
			? {}
			: {
					fallbackSource: fallbackSource as string,
					requiresScripts: requiresScripts as string[],
				}),
	};
}

function asTargets(raw: unknown, where: string): DiscoveredTargets | RosterTargets {
	if (raw === null || typeof raw !== 'object') fail(`${where} targets must be an object.`);
	const targets = raw as Record<string, unknown>;
	if (targets['model'] === 'roster') {
		const roster = targets['roster'];
		if (typeof roster !== 'string' || roster.length === 0) {
			fail(`${where} roster targets need a roster filename.`);
		}
		return { model: 'roster', roster };
	}
	if (targets['model'] === 'discovered') {
		const marker = targets['marker'];
		if (marker !== undefined && (typeof marker !== 'string' || marker.length === 0)) {
			fail(`${where} discovered marker must be a non-empty path when present.`);
		}
		return { model: 'discovered', ...(typeof marker === 'string' ? { marker } : {}) };
	}
	return fail(`${where} targets.model must be 'roster' or 'discovered'.`);
}

function asGroup(raw: unknown, index: number): SharedCoreGroup {
	if (raw === null || typeof raw !== 'object') fail(`group ${index} must be an object.`);
	const group = raw as Record<string, unknown>;
	const name = group['name'];
	if (typeof name !== 'string' || name.length === 0) fail(`group ${index} needs a name.`);
	const where = `group '${name}'`;

	const owner = group['owner'];
	if (typeof owner !== 'string' || !OWNERS.has(owner)) {
		fail(`${where} owner must be one of: ${[...OWNERS].join(', ')}.`);
	}
	for (const key of ['sourceRoot', 'targetRoot'] as const) {
		if (typeof group[key] !== 'string' || (group[key] as string).length === 0) {
			fail(`${where} needs a non-empty ${key}.`);
		}
	}
	const rawFiles = group['files'];
	if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
		fail(`${where} needs at least one file.`);
	}
	const files = rawFiles.map((file, i) => asFile(file, `${where} file ${i}`));

	const hook = group['hook'];
	if (hook !== undefined) {
		if (typeof hook !== 'string' || hook.length === 0) fail(`${where} hook must be a string.`);
		if (!files.some((f) => (f.target ?? f.source) === hook)) {
			fail(`${where} hook '${hook}' is not among the files the group carries.`);
		}
	}
	for (const key of ['hookMarker', 'localChainMarker'] as const) {
		const marker = group[key];
		if (marker === undefined) continue;
		if (typeof marker !== 'string' || marker.length === 0) {
			fail(`${where} ${key} must be a non-empty string.`);
		}
		if (hook === undefined) fail(`${where} declares ${key} but no hook.`);
	}

	// A hook plus every guard it chains, as one unit. core.hooksPath allows exactly one hook of
	// each name, and these hooks run under `set -euo pipefail`, so a hook installed without a guard
	// it calls is not a partial install — it is a repository whose every push or commit fails. That
	// is strictly worse than no install, which is why this is a load-time error and not a warning.
	const wiring = group['wiring'];
	if (wiring !== undefined) {
		if (wiring === null || typeof wiring !== 'object' || Array.isArray(wiring)) {
			fail(`${where} wiring must be an object of script name to command.`);
		}
		if (group['requiresPackageJson'] !== true) {
			fail(`${where} declares wiring but not requiresPackageJson: true.`);
		}
		for (const [key, required] of Object.entries(wiring as Record<string, unknown>)) {
			if (typeof required !== 'string' || required.length === 0) {
				fail(`${where} wiring ${key} must be a non-empty string.`);
			}
		}
	}

	return {
		files,
		name,
		owner,
		sourceRoot: group['sourceRoot'] as string,
		targetRoot: group['targetRoot'] as string,
		targets: asTargets(group['targets'], where),
		...(typeof hook === 'string' ? { hook } : {}),
		...(typeof group['hookMarker'] === 'string' ? { hookMarker: group['hookMarker'] } : {}),
		...(typeof group['localChainMarker'] === 'string'
			? { localChainMarker: group['localChainMarker'] }
			: {}),
		...(wiring === undefined ? {} : { wiring: wiring as Record<string, string> }),
		...(group['requiresPackageJson'] === true ? { requiresPackageJson: true } : {}),
	};
}

/** Reads and validates the manifest. Throws on anything it cannot verify. */
export function loadManifest(scriptsDir: string): SharedCoreGroup[] {
	const path = join(scriptsDir, 'shared-core-manifest.json');
	if (!existsSync(path)) fail(`not found at ${path}.`);

	const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
	const rawGroups = (parsed as null | Record<string, unknown>)?.['groups'];
	if (!Array.isArray(rawGroups) || rawGroups.length === 0) {
		fail('expected a non-empty "groups" array.');
	}
	const groups = rawGroups.map(asGroup);

	const names = new Set<string>();
	const writes = new Set<string>();
	for (const group of groups) {
		if (names.has(group.name)) fail(`two groups are named '${group.name}'.`);
		names.add(group.name);

		// Two groups writing the same path is a race whose winner depends on manifest order, and
		// whichever loses reports success anyway.
		for (const file of group.files) {
			const destination = `${group.targetRoot}/${file.target ?? file.source}`;
			if (writes.has(destination)) fail(`two groups both write ${destination}.`);
			writes.add(destination);
		}
	}
	return groups;
}
