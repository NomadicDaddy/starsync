import path from 'node:path';

export const stripQuotes = (value: string): string => value.trim().replace(/^['"]|['"]$/g, '');

export const resolveTargetPath = (
	positional: null | string,
	envTarget: string | undefined,
	baseDir: string
): string => {
	if (positional) return path.resolve(positional);
	const envValue = envTarget ? stripQuotes(envTarget) : '';
	if (envValue) return path.resolve(envValue);
	return path.resolve(baseDir, 'starred_repos');
};
