import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

// Every dotenv file Bun loads on its own: the base file, the local override, and the overlay for
// each NODE_ENV it recognizes, with their local forms. Any of them can carry a forge token, so none
// may ever be eligible for a commit.
const DOTENV_FILES = [
	'.env',
	'.env.local',
	'.env.development',
	'.env.development.local',
	'.env.production',
	'.env.production.local',
	'.env.test',
	'.env.test.local',
];

// --no-index asks the ignore rules alone, so a file that happens to be tracked or present in this
// checkout cannot change the answer. Exit 0 means ignored, 1 means not ignored.
const checkIgnore = (relativePath: string): number => {
	const result = Bun.spawnSync({
		cmd: ['git', 'check-ignore', '--quiet', '--no-index', '--', relativePath],
		cwd: repositoryRoot,
		stderr: 'pipe',
		stdout: 'pipe',
		windowsHide: true,
	});
	return result.exitCode ?? -1;
};

describe('repository ignore rules', () => {
	test.each(DOTENV_FILES)('ignores the dotenv file %s', (dotenvFile) => {
		expect(checkIgnore(dotenvFile)).toBe(0);
	});

	test('keeps the documented .env.example trackable', () => {
		expect(checkIgnore('.env.example')).toBe(1);
	});
});
