import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveArchiveTarget } from '../src/lib/cli-target.ts';
import { parseArgs, parseSubcommandArgs } from '../src/lib/cli-utils.ts';

const temporaryPaths: string[] = [];
const makeTarget = (host?: string): string => {
	const target = mkdtempSync(path.join(tmpdir(), 'starsync-host-target-'));
	temporaryPaths.push(target);
	if (host !== undefined) {
		mkdirSync(path.join(target, '.starsync'));
		writeFileSync(
			path.join(target, '.starsync', 'config.json'),
			JSON.stringify({
				archiveFormat: 2,
				host,
				owner: { id: 7, login: 'example' },
			}),
		);
	}
	return target;
};

afterEach(() => {
	for (const target of temporaryPaths.splice(0)) rmSync(target, { force: true, recursive: true });
});

const runCli = (args: string[], environment: Record<string, string> = {}) =>
	Bun.spawnSync({
		cmd: [process.execPath, 'src/cli.ts', ...args],
		cwd: path.resolve(import.meta.dir, '..'),
		env: {
			...process.env,
			CODEBERG_TOKEN: '',
			GITHUB_TOKEN: '',
			TARGET_PATH: '',
			TARGET_PATH_CODEBERG: '',
			TARGET_PATH_GITHUB: '',
			...environment,
		},
		stderr: 'pipe',
		stdout: 'pipe',
	});

describe('host-specific target paths', () => {
	test('parses both host spellings for sync and every other command parser', () => {
		for (const parse of [parseArgs, parseSubcommandArgs]) {
			expect(parse([]).host).toBeNull();
			for (const host of ['github.com', 'codeberg.org'] as const) {
				expect(parse(['--host', host, 'archive']).host).toBe(host);
				expect(parse([`--host=${host}`, 'archive']).targetPath).toBe('archive');
			}
			for (const args of [
				['--host'],
				['--host='],
				['--host=evil.test'],
				['--host=github.com', '--host=codeberg.org'],
			]) {
				expect(() => parse(args)).toThrow();
			}
		}
	});

	test('selects symmetric defaults, with a GitHub-only absent-value fallback', () => {
		const github = makeTarget('github.com');
		const codeberg = makeTarget('codeberg.org');
		const fallback = makeTarget('github.com');
		const environment = {
			TARGET_PATH: fallback,
			TARGET_PATH_CODEBERG: codeberg,
			TARGET_PATH_GITHUB: github,
		};
		expect(resolveArchiveTarget(parseArgs([]), environment)).toBe(github);
		expect(resolveArchiveTarget(parseArgs(['--host=codeberg.org']), environment)).toBe(
			codeberg,
		);
		expect(resolveArchiveTarget(parseArgs([]), { TARGET_PATH: fallback })).toBe(fallback);
		expect(() =>
			resolveArchiveTarget(parseArgs(['--host=codeberg.org']), {
				TARGET_PATH: fallback,
				TARGET_PATH_GITHUB: github,
			}),
		).toThrow('TARGET_PATH_CODEBERG');
		for (const empty of ['', ' ', '""', "''"]) {
			expect(() =>
				resolveArchiveTarget(parseArgs([]), {
					TARGET_PATH: fallback,
					TARGET_PATH_GITHUB: empty,
				}),
			).toThrow('non-empty');
			expect(() =>
				resolveArchiveTarget(parseArgs(['--host=codeberg.org']), {
					...environment,
					TARGET_PATH_CODEBERG: empty,
				}),
			).toThrow('non-empty');
			expect(() => resolveArchiveTarget(parseArgs([empty]), environment)).toThrow(
				'non-empty',
			);
		}
	});

	test('positional paths win and preserve recorded hosts unless explicitly contradicted', () => {
		const github = makeTarget('github.com');
		const codeberg = makeTarget('codeberg.org');
		const environment = { TARGET_PATH_CODEBERG: codeberg, TARGET_PATH_GITHUB: github };
		expect(resolveArchiveTarget(parseArgs([`"${codeberg}"`]), environment)).toBe(codeberg);
		expect(
			resolveArchiveTarget(parseArgs(['--host=github.com', github]), {
				TARGET_PATH_GITHUB: '',
			}),
		).toBe(github);
		expect(() =>
			resolveArchiveTarget(parseArgs(['--host=github.com', codeberg]), environment),
		).toThrow('does not match');
		expect(() =>
			resolveArchiveTarget(parseArgs(['--host=codeberg.org', github]), environment),
		).toThrow('does not match');
	});

	test('all six commands refuse a cross-host selection before touching the archive', () => {
		for (const host of ['github.com', 'codeberg.org']) {
			const target = makeTarget(host);
			const config = path.join(target, '.starsync', 'config.json');
			const before = readFileSync(config, 'utf8');
			const selected = host === 'github.com' ? 'codeberg.org' : 'github.com';
			for (const command of ['init', 'sync', 'verify', 'rename', 'dates', 'unlock']) {
				const result = runCli([command, '--json', `--host=${selected}`, target]);
				expect(result.exitCode).toBe(2);
				expect(result.stdout.toString()).toContain('does not match archive host');
				expect(readFileSync(config, 'utf8')).toBe(before);
			}
		}
	});

	test('CLI selects both defaults, accepts explicit Codeberg paths, and keeps help usable', () => {
		const github = makeTarget('github.com');
		const codeberg = makeTarget('codeberg.org');
		const environment = { TARGET_PATH_CODEBERG: codeberg, TARGET_PATH_GITHUB: github };
		for (const [args, target] of [
			[['unlock', '--json'], github],
			[['unlock', '--json', '--host', 'codeberg.org'], codeberg],
			[['unlock', '--json', codeberg], codeberg],
		] as const) {
			const result = runCli([...args], environment);
			expect(result.exitCode).toBe(0);
			const report = JSON.parse(result.stdout.toString()) as { targetPath: string };
			expect(report.targetPath).toBe(target);
		}
		for (const command of ['init', 'sync', 'verify', 'rename', 'dates', 'unlock']) {
			expect(runCli([command, '--host=codeberg.org', '--help']).exitCode).toBe(0);
			expect(runCli([command, '--host=codeberg.org']).exitCode).toBe(2);
		}
	});

	test('keeps absent-host archives bound to GitHub and strips quotes from host defaults', () => {
		const target = makeTarget('github.com');
		writeFileSync(
			path.join(target, '.starsync', 'config.json'),
			JSON.stringify({
				archiveFormat: 2,
				owner: { id: 7, login: 'example' },
			}),
		);
		expect(
			resolveArchiveTarget(parseArgs(['--host=github.com']), {
				TARGET_PATH_GITHUB: `"${target}"`,
			}),
		).toBe(target);
		expect(() => resolveArchiveTarget(parseArgs(['--host=codeberg.org', target]), {})).toThrow(
			'archive host github.com',
		);
	});
});
