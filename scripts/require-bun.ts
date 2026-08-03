// Contributor guard: fail any install of this repository that is not driven by bun. Replaces
// only-allow — a guard that has to bunx-download itself is a network/cache race (three workspace
// preinstalls racing one bunx cache flaked in CI), and a bare `only-allow` binary only exists in
// a node_modules the script runs too early to see. Package managers all advertise themselves in
// npm_config_user_agent; bun's starts with "bun/".
//
// This runs on `prepare`, not `preinstall`, because the guard itself needs bun to execute it.
// On `preinstall` it also ran for anyone consuming the published package, so `npx starsync`
// died on "bun: not found" before the CLI was ever reached. `prepare` runs for a working copy
// and for a git dependency, and never for an install from the registry, which is exactly the
// set of installs this is meant to police. The cost is that it reports after dependencies are
// written rather than before.
const userAgent = process.env['npm_config_user_agent'] ?? '';
if (!userAgent.startsWith('bun/')) {
	console.error('Use "bun install" for installation in this project.');
	console.error("If you don't have Bun, see https://bun.sh/docs/installation");
	process.exit(1);
}
