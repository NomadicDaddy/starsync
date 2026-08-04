import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const scanRoots = ['scripts', 'src', 'test'];
const skippedDirs = new Set(['.git', 'build', 'coverage', 'data', 'dist', 'logs', 'node_modules']);
const scannedExtensions = new Set(['.js', '.mjs', '.ts', '.tsx']);

function extension(path: string): string {
	const match = /\.[^.\\/]+$/.exec(path);
	return match?.[0] ?? '';
}

async function collectSourceFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	const entries = await readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			if (!skippedDirs.has(entry.name)) {
				files.push(...(await collectSourceFiles(path)));
			}
			continue;
		}
		if (entry.isFile() && scannedExtensions.has(extension(entry.name))) {
			files.push(path);
		}
	}
	return files;
}

function relativeRepoPath(path: string): string {
	return relative(repoRoot, path).split(sep).join('/');
}

function directGitSpawnLine(lines: string[], index: number): boolean {
	const line = lines[index] ?? '';
	// Single-line launches where the call and its 'git' first argument share a line. Sync and
	// execFile forms must be matched too: `Bun.spawnSync(['git', …])` and `execFileSync('git', …)`
	// each spawn a real console window on Windows exactly as the async spawn form does, but earlier
	// patterns could not match the Sync/array/execFile variants, so those call sites were invisible
	// to this check and the production Git paths slipped past it.
	if (
		/(?:Bun\.)?spawn(?:Sync)?\(\s*['"]git['"]/.test(line) ||
		/Bun\.spawn(?:Sync)?\(\s*\[\s*['"]git['"]/.test(line) ||
		/execFile(?:Sync)?\(\s*['"]git['"]/.test(line)
	) {
		return true;
	}
	// The 'git' first argument may sit on its own line beneath the call opener — e.g.
	// `execFile(\n\t'git',` or `Bun.spawnSync(\n\t['git',` — so a line-based scan has to detect the
	// opener and confirm a git argument on the lines that follow, or those call sites stay hidden.
	const opener = line.match(/\b(?:Bun\.)?(?:spawn(?:Sync)?|execFile(?:Sync)?)\s*\(\s*$/);
	if (!opener) return false;
	const following = lines.slice(index + 1, Math.min(index + 4, lines.length)).join(' ');
	return /['"]git['"]/.test(following);
}

describe('Git subprocess window visibility', () => {
	test('direct Git subprocesses request hidden Windows process windows', async () => {
		const files = (
			await Promise.all(scanRoots.map((root) => collectSourceFiles(join(repoRoot, root))))
		).flat();
		const violations: string[] = [];

		for (const file of files) {
			if (relativeRepoPath(file) === 'test/git-window-hide.test.ts') continue;
			const text = await readFile(file, 'utf8');
			const lines = text.split(/\r?\n/);
			for (let index = 0; index < lines.length; index++) {
				if (!directGitSpawnLine(lines, index)) continue;
				const block = lines.slice(index, Math.min(index + 14, lines.length)).join('\n');
				if (!/windowsHide:\s*true/.test(block)) {
					violations.push(`${relativeRepoPath(file)}:${index + 1}`);
				}
			}
		}

		expect(violations).toEqual([]);
	});
});
