#!/usr/bin/env bash
# Shared by aidd, spernakit and starsync; distribute through push-guards and the scaffold.
# The tagged tree decides whether capture is required. Historical trees without the declaration
# are exempt. Opted-in historical trees with an unversioned declaration fail closed and need a
# separately agreed historical-release policy; neither missing evidence nor --no-verify is supported.
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
try {
	const contract = JSON.parse(git('show', `${commit}:.screenshot-capture`));
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
	echo "PUSH BLOCKED: run bun run smoke:screenshots against the clean tagged production candidate." >&2
	echo "A complete matching full crawl and analyzer verdict are required; diagnostics cannot replace them." >&2
	exit 1
fi
