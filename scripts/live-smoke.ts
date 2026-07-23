import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	normalizeArchiveDates,
	syncArchive,
	verifyArchive,
	type CommandReport,
} from '../src/index.ts';

const usage = 'Usage: STARSYNC_LIVE_SMOKE=1 bun run smoke:live -- <temporary-managed-archive>';

const failUsage = (message: string): never => {
	console.error(message);
	console.error(usage);
	process.exit(2);
};

const resolveExistingDirectory = (value: string): string => {
	const resolved = fs.realpathSync(value);
	if (!fs.statSync(resolved).isDirectory()) {
		failUsage(`Live smoke target is not a directory: ${resolved}`);
	}
	return resolved;
};

const isWithinDirectory = (candidate: string, directory: string): boolean => {
	const relative = path.relative(directory, candidate);
	return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const samePath = (left: string, right: string): boolean => {
	const normalize = (value: string): string => {
		const normalized = path.normalize(value).normalize('NFC');
		return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
	};
	return normalize(left) === normalize(right);
};

const run = async (): Promise<void> => {
	if (process.env.STARSYNC_LIVE_SMOKE !== '1') {
		failUsage('Live smoke is disabled. Set STARSYNC_LIVE_SMOKE=1 to opt in explicitly.');
	}

	const args = process.argv.slice(2).filter((arg) => arg !== '--');
	if (args.length !== 1) {
		failUsage('Live smoke requires exactly one caller-supplied target path.');
	}
	const targetArgument =
		args[0] ?? failUsage('Live smoke requires exactly one caller-supplied target path.');
	const targetPath = resolveExistingDirectory(targetArgument);
	const temporaryRoot = fs.realpathSync(os.tmpdir());
	if (!isWithinDirectory(targetPath, temporaryRoot)) {
		failUsage(`Live smoke target must be below the OS temporary directory: ${temporaryRoot}`);
	}

	const configuredTarget = process.env.TARGET_PATH?.trim();
	if (configuredTarget !== undefined && configuredTarget !== '') {
		const configuredPath = path.resolve(configuredTarget.replace(/^['"]|['"]$/g, ''));
		const canonicalConfiguredPath = fs.existsSync(configuredPath)
			? fs.realpathSync(configuredPath)
			: configuredPath;
		if (samePath(canonicalConfiguredPath, targetPath)) {
			failUsage('Live smoke refuses to run against the configured archive.');
		}
	}

	const token = process.env.GITHUB_TOKEN?.trim() ?? '';
	if (token === '') {
		failUsage('Live smoke requires GITHUB_TOKEN for the read-only synchronization preview.');
	}

	const verification = await verifyArchive({ targetPath });
	const synchronization = await syncArchive({ dryRun: true, targetPath, token });
	const dates = await normalizeArchiveDates({ dryRun: true, targetPath });
	const reports: Record<string, CommandReport> = {
		dates,
		synchronization,
		verification,
	};
	console.log(JSON.stringify(reports, null, 2));

	if (Object.values(reports).some((report) => report.exitCode !== 0)) {
		process.exitCode = 1;
	}
};

await run().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
