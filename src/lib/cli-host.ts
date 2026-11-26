import type { ArchiveHost } from './archive-host.ts';

import { readArchiveConfig } from './archive-config.ts';
import { hostTokenName, parseArchiveHost } from './archive-host.ts';

export const parseHostArgs = (argv: string[]): { argv: string[]; host: ArchiveHost | null } => {
	const rest: string[] = [];
	let host: ArchiveHost | null = null;
	let seen = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg !== '--host' && !arg.startsWith('--host=')) {
			rest.push(arg);
			continue;
		}
		if (seen) throw new Error('--host may only be specified once.');
		seen = true;
		const value = arg === '--host' ? argv[++index] : arg.slice(7);
		if (value === undefined) throw new Error('--host requires github.com or codeberg.org.');
		host = parseArchiveHost(value);
	}
	return { argv: rest, host };
};

export const tokenForHost = (host: ArchiveHost): string => process.env[hostTokenName(host)] ?? '';

export const tokenForArchive = (targetPath: string): string => {
	try {
		return tokenForHost(readArchiveConfig(targetPath).host ?? 'github.com');
	} catch {
		return '';
	}
};
