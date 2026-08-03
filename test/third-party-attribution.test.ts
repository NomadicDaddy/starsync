import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const readRepositoryFile = (relativePath: string): string =>
	readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

const readRepositoryJson = (relativePath: string): Record<string, unknown> =>
	JSON.parse(readRepositoryFile(relativePath)) as Record<string, unknown>;

const scripts = (): Record<string, string> =>
	readRepositoryJson('package.json')['scripts'] as Record<string, string>;

const claimedCount = (content: string): number =>
	Number(/covers\s+\*\*(\d+)\*\*\s+third-party package versions/.exec(content)?.[1]);

describe('third-party attribution', () => {
	test('runs both license checks from one entry point', () => {
		// The pre-commit hook and smoke:qc both call `check:licenses` by name. Dropping either
		// half here silently stops enforcing it everywhere at once.
		const check = scripts()['check:licenses'];

		expect(check).toContain('check:license-core');
		expect(check).toContain('generate-third-party-licenses.ts --check');
		expect(scripts()['licenses:generate']).toBe('bun scripts/generate-third-party-licenses.ts');
	});

	test('attributes every declared production dependency', () => {
		const declared = Object.keys(
			readRepositoryJson('package.json')['dependencies'] as Record<string, unknown>,
		);
		const summary = readRepositoryFile('THIRD_PARTY_LICENSES.md');

		expect(declared.length).toBeGreaterThan(0);
		for (const name of declared) {
			expect(summary).toContain(`[${name}](https://www.npmjs.com/package/${name})`);
		}
	});

	test('reproduces a notice for every package version the appendix claims to cover', () => {
		// The summary names license families; only the appendix carries the per-package copyright
		// lines MIT, BSD and ISC each require a redistributor to pass on. A count that no longer
		// matches its own section list means packages were dropped from the walk, which is the
		// failure this document exists to prevent — and it looks like a complete file either way.
		const notices = readRepositoryFile('THIRD_PARTY_NOTICES.md');
		const sections = [...notices.matchAll(/^### /gm)].length;

		expect(sections).toBeGreaterThan(0);
		expect(claimedCount(notices)).toBe(sections);
		expect(claimedCount(readRepositoryFile('THIRD_PARTY_LICENSES.md'))).toBe(sections);
	});
});
