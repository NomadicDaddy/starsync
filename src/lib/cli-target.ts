import fs from 'node:fs';
import path from 'node:path';

import type { ArchiveHost } from './archive-host.ts';

import { ARCHIVE_CONFIG_DIRECTORY, readArchiveConfig } from './archive-config.ts';
import { resolveTargetPath, stripQuotes } from './cli-utils.ts';

interface TargetSelection {
	host: ArchiveHost | null;
	targetPath: null | string;
}

const targetEnvironment = (
	host: ArchiveHost,
	environment: Record<string, string | undefined>,
): { value: string | undefined; variable: string } => {
	const variable = host === 'codeberg.org' ? 'TARGET_PATH_CODEBERG' : 'TARGET_PATH_GITHUB';
	// Only an absent GitHub-specific value permits the existing GitHub fallback.
	const value =
		environment[variable] ?? (host === 'github.com' ? environment.TARGET_PATH : undefined);
	return { value, variable };
};

const requireMatchingHost = (target: string, host: ArchiveHost | null): void => {
	if (
		host === null ||
		!fs.existsSync(path.join(target, ARCHIVE_CONFIG_DIRECTORY, 'config.json'))
	) {
		return;
	}
	const recordedHost = readArchiveConfig(target).host ?? 'github.com';
	if (recordedHost !== host) {
		throw new Error(`Selected host ${host} does not match archive host ${recordedHost}.`);
	}
};

export const resolveArchiveTarget = (
	selection: TargetSelection,
	environment: Record<string, string | undefined> = process.env,
): string => {
	const { value: envTarget, variable } = targetEnvironment(
		selection.host ?? 'github.com',
		environment,
	);
	const positional = selection.targetPath === null ? null : stripQuotes(selection.targetPath);
	if (positional === '' || (positional === null && !stripQuotes(envTarget ?? ''))) {
		throw new Error(`A non-empty target path or ${variable} is required.`);
	}
	const target = resolveTargetPath(positional, envTarget);
	const selectedHost = selection.host ?? (selection.targetPath === null ? 'github.com' : null);
	requireMatchingHost(target, selectedHost);
	return target;
};
