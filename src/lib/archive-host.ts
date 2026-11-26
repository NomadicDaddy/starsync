export type ArchiveHost = 'codeberg.org' | 'github.com';

export const parseArchiveHost = (value: unknown = 'github.com'): ArchiveHost => {
	if (value === 'github.com' || value === 'codeberg.org') return value;
	throw new Error('Archive host must be github.com or codeberg.org.');
};

export const hostTokenName = (host: ArchiveHost): string =>
	host === 'codeberg.org' ? 'CODEBERG_TOKEN' : 'GITHUB_TOKEN';
