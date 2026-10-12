import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const readRepositoryFile = (relativePath: string): string =>
	readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

const readRepositoryJson = (relativePath: string): Record<string, unknown> =>
	JSON.parse(readRepositoryFile(relativePath)) as Record<string, unknown>;

const section = (relativePath: string, key: string): Record<string, unknown> =>
	readRepositoryJson(relativePath)[key] as Record<string, unknown>;

// knip.json is JSONC — Knip documents and accepts comments in its configuration, and this
// repository uses them to record why each entry point and exemption exists. JSON.parse alone
// cannot read it, so line comments are stripped first, tracking strings so a `//` inside a value
// survives. Block comments are not used in the file.
const stripLineComment = (line: string): string => {
	let inString = false;
	for (let index = 0; index < line.length; index++) {
		const char = line[index] ?? '';
		if (char === '\\') {
			index++;
			continue;
		}
		if (char === '"') inString = !inString;
		if (!inString && char === '/' && line[index + 1] === '/') return line.slice(0, index);
	}
	return line;
};

const readRepositoryJsonc = (relativePath: string): Record<string, unknown> =>
	JSON.parse(
		readRepositoryFile(relativePath).split(/\r?\n/).map(stripLineComment).join('\n'),
	) as Record<string, unknown>;

const runInstallGuard = (userAgent: string): { exitCode: number; stderr: string } => {
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			fileURLToPath(new URL('../scripts/require-bun.ts', import.meta.url)),
		],
		env: { ...process.env, npm_config_user_agent: userAgent },
		stderr: 'pipe',
		stdout: 'pipe',
	});
	return { exitCode: result.exitCode ?? 0, stderr: result.stderr.toString() };
};

describe('package distribution', () => {
	test('resolves every entry point into the built output', () => {
		const manifest = readRepositoryJson('package.json');

		expect(manifest['bin']).toEqual({ starsync: './dist/cli.js' });
		expect(manifest['main']).toBe('./dist/index.js');
		expect(manifest['module']).toBe('./dist/index.js');
		expect(manifest['types']).toBe('./dist/types/index.d.ts');

		// Naming src/ here is what kept the package Bun-only: a consumer under Node received
		// TypeScript it could not execute. The tarball carries built output and nothing else.
		expect(manifest['files']).toEqual([
			'dist/cli.js',
			'dist/index.js',
			'dist/types',
			'README.md',
			'LICENSE',
		]);
	});

	test('is publishable and declares both supported runtimes', () => {
		const manifest = readRepositoryJson('package.json');
		const engines = section('package.json', 'engines');

		expect(manifest['private']).toBeUndefined();
		expect(engines['bun']).toBe('>=1.4.2');
		expect(engines['node']).toBe('>=24.0.0');
	});

	test('runs the install guard on prepare rather than preinstall', () => {
		const scripts = section('package.json', 'scripts');

		// On preinstall the guard also ran for anyone installing the published package, so
		// `npx starsync` died on a missing Bun before the CLI was ever reached. prepare covers
		// a working copy and a Git dependency, and never an install from the registry.
		expect(scripts['preinstall']).toBeUndefined();
		expect(scripts['prepare']).toContain('scripts/require-bun.ts');

		// prepare has to build as well, because bin, main, module, and types all name files
		// that a gitignored dist/ leaves absent in a fresh clone or a Git dependency.
		expect(scripts['prepare']).toContain('bun run build');
		expect(scripts['prepublishOnly']).toContain('smoke:qc');
	});

	test('reaches shell scripts through the bash resolver rather than PATH', () => {
		const scripts = section('package.json', 'scripts');

		// C:\Windows\System32\bash.exe is the WSL launcher, and it shadows Git's bash for every
		// process whose PATH does not prepend Git's usr/bin. A bare `bash` therefore passes from
		// Git Bash and fails from PowerShell on the same machine, which reached a release as
		// prepublishOnly -> smoke:qc -> check:leak-guard dying on execvpe(/bin/bash). Shell
		// scripts are invoked through scripts/run-bash.ts, which resolves Git's own bash.
		const bareBash = Object.entries(scripts).filter(([, command]) =>
			/(?:^|\s|\()bash\s/.test(String(command)),
		);

		expect(bareBash).toEqual([]);
		expect(scripts['check:leak-guard']).toContain('scripts/run-bash.ts');
		expect(scripts['prepare']).toContain('scripts/run-bash.ts');
	});

	test('builds both entry points for node with dependencies left external', () => {
		const scripts = section('package.json', 'scripts');
		const bundle = String(scripts['build:bundle']);

		expect(bundle).toContain('./src/cli.ts');
		expect(bundle).toContain('./src/index.ts');
		expect(bundle).toContain('--target=node');
		// Without this the declared dependencies get inlined, and main stops matching the
		// dependency set the manifest promises a consumer.
		expect(bundle).toContain('--packages=external');
		expect(String(scripts['build'])).toContain('build:types');
	});

	test('starts the CLI with a node shebang', () => {
		// bun build copies the entry shebang into dist/cli.js verbatim, and that bundle is the
		// published bin, so this line has to name the runtime the bundle expects rather than
		// the one contributors use.
		expect(readRepositoryFile('src/cli.ts').split(/\r?\n/)[0]).toBe('#!/usr/bin/env node');
	});

	test('keeps declaration emit out of the base tsconfig', () => {
		const base = section('tsconfig.json', 'compilerOptions');
		const types = readRepositoryJson('tsconfig.types.json');
		const options = types['compilerOptions'] as Record<string, unknown>;

		expect(base['noEmit']).toBe(true);
		expect(types['extends']).toBe('./tsconfig.json');
		expect(options['declaration']).toBe(true);
		expect(options['emitDeclarationOnly']).toBe(true);
		expect(options['noEmit']).toBe(false);
		expect(options['outDir']).toBe('dist/types');
	});

	test('rejects an install that is not driven by bun', () => {
		const result = runInstallGuard('npm/11.16.0 node/v24.18.1 win32 x64');

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Use "bun install" for installation in this project.');
	});

	test('accepts an install driven by bun', () => {
		expect(runInstallGuard('bun/1.4.2 npm/? node/v24.18.1 win32 x64').exitCode).toBe(0);
	});

	test('wires dead-code detection into the release gate', () => {
		const devDependencies = section('package.json', 'devDependencies');
		const scripts = section('package.json', 'scripts');

		// The detector is a pinned dependency rather than a session-level `bunx` fallback, so the
		// release matrix installs the exact analyzed version from the lockfile.
		expect(devDependencies['knip']).toBe('6.32.2');

		// `check:dead-code` is the gate's name, and `smoke:qc` runs it before the test suite. The
		// position is asserted because the release workflow's quality step is `smoke:qc` itself,
		// and a detector appended after the tests would still gate the release — but one appended
		// after a failing test would never run at all, leaving the release blocked for the wrong
		// reason and the dead code invisible.
		expect(scripts['check:dead-code']).toBe('knip --no-progress');
		const smoke = String(scripts['smoke:qc']);
		expect(smoke).toContain('bun run check:dead-code');
		expect(smoke.indexOf('check:dead-code')).toBeLessThan(smoke.indexOf('bun run test'));
	});

	test('analyzes the process-launched test suite as knip entry points', () => {
		const knip = readRepositoryJsonc('knip.json');
		const entry = knip['entry'] as string[];

		// scripts/test.ts discovers every test by glob and hands the list to Bun subprocesses, so
		// Knip's Bun plugin — which reads `bun test` targets from package.json — cannot see them.
		// Without the glob as an explicit entry, the entire suite reports as unused files.
		expect(entry).toContain('test/**/*.test.ts');
	});
});
