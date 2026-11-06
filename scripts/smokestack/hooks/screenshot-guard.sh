#!/usr/bin/env bash
# smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
# smokestack; every repository that takes it holds a byte-identical copy.
# The tagged tree decides whether capture is required. Historical trees without the declaration
# are exempt. Opted-in historical trees with an unversioned declaration fail closed and need a
# separately agreed historical-release policy; neither missing evidence nor --no-verify is supported.
# A declaration is either a routes contract (a full crawl of at least 5 routes) or a states contract
# ("evidence": "states", at least 3 interaction states of one page), each with its own evidence.
set -euo pipefail
problems=0
while read -r local_ref local_sha _remote_ref _remote_sha; do
	[ -z "${local_sha:-}" ] && continue
	[ "$local_sha" = 0000000000000000000000000000000000000000 ] && continue
	case "$local_ref" in refs/tags/v[0-9]*) ;; *) continue ;; esac
	version="${local_ref#refs/tags/}"
	if ! commit=$(git rev-parse --verify "$local_sha^{commit}" 2>/dev/null); then
		echo "tag $version: cannot resolve tagged commit" >&2
		problems=1
		continue
	fi
	if ! git cat-file -e "$commit:.screenshot-capture" 2>/dev/null; then
		echo "tag $version: tagged tree has no .screenshot-capture; capture is not required" >&2
		continue
	fi
	if ! bun - "$commit" "$version" <<'JAVASCRIPT'
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const [commit, tag] = process.argv.slice(2);
const fail = message => { throw new Error(message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim();
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const regular = path => { if (!lstatSync(path).isFile()) fail(`Not a regular file: ${path}`); };
const directory = path => { if (!lstatSync(path).isDirectory()) fail(`Not a directory: ${path}`); };
// A states contract names a few interaction states of one page instead of routes a crawl reaches.
// Its evidence is screenshots/<tag>/release-states.json, written by record-release-states.ts at
// the clean candidate: one PNG per declared state, each checked here by hash, size and identity.
const states = contract => {
	const names = contract.states;
	if (Object.keys(contract).sort().join(',') !== 'evidence,schema,states,viewport' ||
		contract.schema !== 1 || !Array.isArray(names) || names.length < 3 ||
		names.some(name => typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name)) ||
		new Set(names).size !== names.length ||
		contract.viewport?.width !== 2250 || contract.viewport?.height !== 1309) {
		fail('Tagged states contract is unsupported: schema 1, at least 3 distinct state names, 2250x1309.');
	}
	const pkg = JSON.parse(git('show', `${commit}:package.json`));
	if (`v${pkg.version}` !== tag) fail('Tag does not match the tagged package version.');
	const tree = git('rev-parse', `${commit}^{tree}`);
	directory('screenshots');
	const candidates = readdirSync('screenshots').filter(name => name === tag || name.startsWith(`${tag}-sv`));
	if (candidates.length !== 1) fail('Expected one version directory with authoritative release evidence.');
	const dir = join('screenshots', candidates[0]);
	directory(dir);
	if (!readdirSync(dir).includes('release-states.json')) {
		fail(`No ${dir}/release-states.json: run record-release-states.ts ${tag} at the clean candidate.`);
	}
	regular(join(dir, 'release-states.json'));
	const manifest = json(join(dir, 'release-states.json'));
	if (manifest.schema !== 1 || manifest.evidence !== 'states' || manifest.version !== pkg.version ||
		manifest.candidate?.commit !== commit || manifest.candidate?.tree !== tree ||
		manifest.candidate?.clean !== true) fail('States capture is missing, unsupported or for another candidate.');
	if (!same(manifest.contract, contract)) fail('Captured states contract differs from tagged tree.');
	const files = names.map(name => `${name}.png`);
	if (!Array.isArray(manifest.images) || !same(manifest.images.map(image => image.state), names) ||
		!same(manifest.images.map(image => image.file), files)) fail('States image inventory differs from the contract.');
	const actual = readdirSync(dir).filter(name => name.endsWith('.png')).sort();
	if (!same(actual, [...files].sort())) fail('Image inventory differs from directory.');
	for (const image of manifest.images) {
		const path = join(dir, image.file);
		regular(path);
		const bytes = readFileSync(path);
		if (hash(bytes) !== image.sha256 || bytes.length < 33 ||
			bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
			bytes.subarray(12, 16).toString() !== 'IHDR' ||
			bytes.subarray(-12).toString('hex') !== '0000000049454e44ae426082' ||
			bytes.readUInt32BE(16) !== contract.viewport.width ||
			bytes.readUInt32BE(20) < contract.viewport.height) fail(`Invalid or changed PNG: ${image.file}`);
	}
	// The images are taken by hand, so two checks stand in for proof they were taken for this
	// release: no two states share an image, and the set is not one already recorded for another
	// release. One unchanged state may honestly repeat its image; a reused directory repeats all.
	// Only release folders kept on this machine can be compared, since screenshots/ is gitignored.
	const hashes = manifest.images.map(image => image.sha256);
	if (new Set(hashes).size !== hashes.length) fail('Two declared states have the same image.');
	for (const other of readdirSync('screenshots').filter(name => name !== candidates[0]).sort()) {
		const recorded = join('screenshots', other, 'release-states.json');
		if (!lstatSync(join('screenshots', other)).isDirectory()) continue;
		if (!readdirSync(join('screenshots', other)).includes('release-states.json')) continue;
		let earlier;
		try {
			earlier = new Set((json(recorded).images ?? []).map(image => image.sha256));
		} catch {
			fail(`${recorded} cannot be read, so this release cannot be compared with it.`);
		}
		if (hashes.every(sha => earlier.has(sha))) fail(`Every image is one already recorded for ${other}.`);
	}
	console.error(`tag ${tag}: verified release states capture (${names.length} states) for ${commit}`);
};
try {
	const contract = JSON.parse(git('show', `${commit}:.screenshot-capture`));
	if (contract?.evidence === 'states') {
		states(contract);
		process.exit(0);
	}
	if (contract?.evidence !== undefined) fail('Tagged capture contract names an unknown kind of evidence.');
	if (contract.schema !== 1 || !Array.isArray(contract.routes) || contract.routes.length < 5 ||
		contract.routes.some(route => typeof route !== 'string') ||
		contract.viewport?.width !== 2250 || contract.viewport?.height !== 1309) {
		fail('Tagged capture contract is unsupported; historical opt-ins need an explicit release policy.');
	}
	const pkg = JSON.parse(git('show', `${commit}:package.json`));
	if (`v${pkg.version}` !== tag) fail('Tag does not match the tagged package version.');
	const tree = git('rev-parse', `${commit}^{tree}`);
	directory('screenshots');
	const candidates = readdirSync('screenshots').filter(name => name === tag || name.startsWith(`${tag}-sv`));
	if (candidates.length !== 1) fail('Expected one version directory with authoritative release evidence.');
	const root = join('screenshots', candidates[0]);
	directory(root);
	regular(join(root, 'release-run.json'));
	const { run } = json(join(root, 'release-run.json'));
	if (typeof run !== 'string' || !/^[0-9a-f-]{36}$/.test(run)) fail('Invalid release run identity.');
	directory(join(root, 'runs'));
	const dir = join(root, 'runs', run);
	directory(dir);
	regular(join(dir, 'crawl-result.json'));
	const manifest = json(join(dir, 'crawl-result.json'));
	if (manifest.schema !== 1 || manifest.run !== run || manifest.status !== 'passed' ||
		manifest.success !== true) fail('Capture is missing, started, failed, or unsupported.');
	if (manifest.version !== pkg.version || manifest.candidate?.commit !== commit ||
		manifest.candidate?.tree !== tree || manifest.candidate?.clean !== true) fail('Candidate identity mismatch.');
	if (!same(manifest.contract, contract)) fail('Captured route contract differs from tagged tree.');
	const scope = manifest.scope;
	if (!scope || scope.page !== null || scope.startFrom !== null || scope.check404 !== true ||
		!same(scope.viewport, contract.viewport)) fail('Capture is narrow or has the wrong viewport.');
	const build = manifest.build;
	if (!build || build.mode !== 'production' || build.version !== pkg.version ||
		build.source?.commit !== commit || build.source?.tree !== tree || build.source?.clean !== true ||
		!Array.isArray(build.assets) || build.assets.length === 0 ||
		build.assets.some(asset => !/^[a-f0-9]{64}$/.test(asset.sha256))) fail('Production build identity is incomplete.');
	regular(join(dir, 'report.json'));
	const reportBytes = readFileSync(join(dir, 'report.json'));
	const digest = hash(reportBytes);
	const report = JSON.parse(reportBytes.toString('utf8'));
	if (manifest.reportSha256 !== digest || manifest.analyzer?.reportSha256 !== digest ||
		manifest.analyzer?.success !== true || !same(manifest.analyzer.failures, []) ||
		report.summary?.success !== true) fail('Full crawl/analyzer verdict is absent, failed, or mismatched.');
	const routes = report.visitedUrls.map(value => {
		const url = new URL(value);
		return url.pathname + url.search;
	});
	if (!same(routes, manifest.routes) || new Set(routes).size !== routes.length) fail('Route inventory mismatch.');
	for (const pattern of contract.routes) {
		if (!routes.some(route => new RegExp(`^(?:${pattern})$`).test(route))) fail(`Missing expected route: ${pattern}`);
	}
	if (!Array.isArray(manifest.images) || manifest.images.length < 5 ||
		manifest.images.length !== report.summary.screenshotsTaken) fail('Incomplete image inventory.');
	const names = manifest.images.map(image => image.file).sort();
	const actual = readdirSync(dir).filter(name => name.endsWith('.png')).sort();
	if (new Set(names).size !== names.length || !same(names, actual)) fail('Image inventory differs from directory.');
	for (const image of manifest.images) {
		if (!/^[a-z0-9_-]+\.png$/.test(image.file) || typeof image.route !== 'string') fail('Invalid image path or route.');
		const path = join(dir, image.file);
		regular(path);
		const bytes = readFileSync(path);
		if (hash(bytes) !== image.sha256 || bytes.length < 33 ||
			bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
			bytes.subarray(12, 16).toString() !== 'IHDR' ||
			bytes.subarray(-12).toString('hex') !== '0000000049454e44ae426082' ||
			bytes.readUInt32BE(16) !== contract.viewport.width ||
			bytes.readUInt32BE(20) < contract.viewport.height) fail(`Invalid or changed PNG: ${image.file}`);
	}
	for (const route of routes) {
		if (!manifest.images.some(image => image.route === route)) fail(`Route has no capture: ${route}`);
	}
	console.error(`tag ${tag}: verified full release capture ${run} for ${commit}`);
} catch (error) {
	console.error(`tag ${tag}: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
JAVASCRIPT
	then
		problems=1
	fi
done
if [ "$problems" -ne 0 ]; then
	echo "PUSH BLOCKED: the tagged release capture is missing or does not match its contract." >&2
	echo "A routes contract needs bun run smoke:screenshots against the clean tagged production candidate:" >&2
	echo "a complete matching full crawl and analyzer verdict; diagnostics cannot replace them." >&2
	echo "A states contract needs bun scripts/smokestack/record-release-states.ts <tag> at that candidate." >&2
	exit 1
fi
