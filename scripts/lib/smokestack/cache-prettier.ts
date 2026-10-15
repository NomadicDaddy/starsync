/**
 * The input list of a `prettier --check .` step: the files Prettier says it covers.
 *
 * The candidates are the repository's git inventory, tracked and untracked-but-not-ignored. That is
 * every file `prettier --check .` can reach, because Prettier skips what .gitignore ignores; each is
 * then put to Prettier itself, with the repository's .gitignore and .prettierignore, and kept when
 * it is not ignored and Prettier has a parser for it. Asking Prettier, rather than repeating its
 * rules here, keeps the list right when a plugin or an ignore file changes what it checks.
 *
 * Prettier is the repository's own, resolved from its root. The runner does not depend on it: a
 * repository that names this collector has Prettier installed, and one that does not is told so.
 */
import { join } from 'node:path';

interface FileInfo {
	ignored: boolean;
	inferredParser: null | string;
}

interface PrettierApi {
	getFileInfo: (
		file: string,
		options: { ignorePath: string[]; resolveConfig: boolean; withNodeModules: boolean },
	) => Promise<FileInfo>;
}

function isPrettier(loaded: unknown): loaded is PrettierApi {
	return (
		loaded !== null &&
		typeof loaded === 'object' &&
		typeof (loaded as Record<string, unknown>)['getFileInfo'] === 'function'
	);
}

async function loadPrettier(root: string): Promise<PrettierApi> {
	let loaded: unknown;
	try {
		loaded = await import(Bun.resolveSync('prettier', root));
	} catch (err) {
		throw new Error(
			`the 'prettier' collector needs Prettier installed in this repository ` +
				`(${err instanceof Error ? err.message : String(err)})`,
			{ cause: err },
		);
	}
	if (!isPrettier(loaded)) throw new Error('the installed Prettier has no getFileInfo');
	return loaded;
}

/** The candidates Prettier checks, as given: repository-relative POSIX paths. */
export async function prettierFiles(root: string, candidates: string[]): Promise<string[]> {
	const prettier = await loadPrettier(root);
	const ignorePath = ['.gitignore', '.prettierignore'].map((name) => join(root, name));
	const covered: string[] = [];
	for (const file of candidates) {
		const info = await prettier.getFileInfo(join(root, file), {
			ignorePath,
			resolveConfig: true,
			withNodeModules: false,
		});
		if (!info.ignored && info.inferredParser !== null) covered.push(file);
	}
	return covered;
}
