import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface DatesOptions {
	dryRun: boolean;
}

interface DatesResult {
	exitCode: number;
}

type Status = 'skipped:no-commit' | 'skipped:not-git' | 'updated' | 'would-update';

interface FolderResult {
	name: string;
	newTime: Date;
	oldTime: Date;
	status: Status;
}

const formatTable = <T extends Record<string, string>>(
	rows: T[],
	columns: (keyof T & string)[]
): void => {
	if (rows.length === 0) return;
	const widths = columns.map((col) => ({
		name: col,
		width: Math.max(col.length, ...rows.map((row) => String(row[col] ?? '').length)),
	}));
	console.log(widths.map((c) => c.name.padEnd(c.width)).join(' | '));
	console.log(widths.map((c) => '-'.repeat(c.width)).join('-+-'));
	for (const row of rows) {
		console.log(widths.map((c) => String(row[c.name] ?? '').padEnd(c.width)).join(' | '));
	}
};

export const runDatesCommand = (target: string, options: DatesOptions): DatesResult => {
	if (!fs.existsSync(target)) {
		console.error(`Root path does not exist: ${target}`);
		return { exitCode: 1 };
	}

	console.log(`Root: ${target}`);

	const results: FolderResult[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(target, { withFileTypes: true });
	} catch (err) {
		console.error(`Cannot read ${target}: ${(err as Error).message}`);
		return { exitCode: 1 };
	}

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;

		const repoPath = path.join(target, entry.name);
		const gitPath = path.join(repoPath, '.git');

		let oldTime: Date;
		try {
			oldTime = fs.statSync(repoPath).mtime;
		} catch (err) {
			console.warn(`Cannot stat ${repoPath}: ${(err as Error).message}`);
			continue;
		}

		if (!fs.existsSync(gitPath)) {
			results.push({
				name: entry.name,
				newTime: oldTime,
				oldTime,
				status: 'skipped:not-git',
			});
			continue;
		}

		try {
			const iso = execFileSync('git', ['-C', repoPath, 'log', '-1', '--format=%cI'], {
				stdio: ['pipe', 'pipe', 'ignore'],
			})
				.toString()
				.trim();
			if (!iso) throw new Error('No commit found');

			const commitTime = new Date(iso);
			if (isNaN(commitTime.getTime())) throw new Error('Invalid date');

			if (!options.dryRun) {
				fs.utimesSync(repoPath, commitTime, commitTime);
			}

			results.push({
				name: entry.name,
				newTime: commitTime,
				oldTime,
				status: options.dryRun ? 'would-update' : 'updated',
			});
		} catch (err) {
			console.warn(`Cannot process ${entry.name}: ${(err as Error).message}`);
			results.push({
				name: entry.name,
				newTime: oldTime,
				oldTime,
				status: 'skipped:no-commit',
			});
		}
	}

	const changed = results.filter((r) => r.status === 'updated' || r.status === 'would-update');
	const skipped = results.filter((r) => r.status !== 'updated' && r.status !== 'would-update');
	const changedLabel = options.dryRun ? 'Would update' : 'Updated';

	console.log(`${changedLabel}: ${changed.length}`);
	console.log(`Skipped: ${skipped.length}`);

	if (changed.length > 0) {
		const toRow = (r: FolderResult) => ({
			Name: r.name,
			NewTime: r.newTime.toLocaleString(),
			OldTime: r.oldTime.toLocaleString(),
		});

		console.log('\nOldest folder timestamps:');
		const oldest = [...changed]
			.sort((a, b) => a.newTime.getTime() - b.newTime.getTime())
			.slice(0, 10)
			.map(toRow);
		formatTable(oldest, ['Name', 'NewTime', 'OldTime']);

		console.log('\nNewest folder timestamps:');
		const newest = [...changed]
			.sort((a, b) => b.newTime.getTime() - a.newTime.getTime())
			.slice(0, 10)
			.map(toRow);
		formatTable(newest, ['Name', 'NewTime', 'OldTime']);
	}

	if (skipped.length > 0) {
		console.log('\nSkipped folders:');
		const skippedData = skipped.map((r) => ({ Name: r.name, Status: r.status }));
		formatTable(skippedData, ['Name', 'Status']);
	}

	return { exitCode: 0 };
};
