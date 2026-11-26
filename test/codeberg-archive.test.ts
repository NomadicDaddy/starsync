import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('Codeberg archive completes an isolated real-Git journey', () => {
	const gitHome = mkdtempSync(path.join(tmpdir(), 'starsync-codeberg-home-'));
	try {
		const result = Bun.spawnSync(
			[process.execPath, 'test', './test/helpers/codeberg-journey.ts', '--timeout', '60000'],
			{ env: { ...process.env, HOME: gitHome, USERPROFILE: gitHome }, timeout: 90000 },
		);
		expect(result.stderr.toString()).toContain('0 fail');
		expect(result.exitCode).toBe(0);
	} finally {
		rmSync(gitHome, { force: true, recursive: true });
	}
}, 100000);
