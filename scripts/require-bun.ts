// Preinstall guard: fail any install not driven by bun. Replaces only-allow — a guard that
// has to bunx-download itself inside preinstall is a network/cache race (three workspace
// preinstalls racing one bunx cache flaked in CI), and a bare `only-allow` binary only exists
// in a node_modules the preinstall runs too early to see. Package managers all advertise
// themselves in npm_config_user_agent; bun's starts with "bun/".
const userAgent = process.env['npm_config_user_agent'] ?? '';
if (!userAgent.startsWith('bun/')) {
	console.error('Use "bun install" for installation in this project.');
	console.error("If you don't have Bun, see https://bun.sh/docs/installation");
	process.exit(1);
}
