import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, '..');

const HELP_TEXT = `set-folder-dates - set each repo folder's mtime to its latest commit time.

Usage:
  bun scripts/set-folder-dates.ts [options] [target-path]

Options:
  --dry-run         Print actions without modifying timestamps
  --help, -h        Show this help

Environment:
  TARGET_PATH       Used if no positional target-path is given.

Default target: <repo>/starred_repos.`;

interface ParsedArgs {
	help: boolean;
	dryRun: boolean;
	targetPath: string | null;
}

const parseArgs = (): ParsedArgs => {
	const parsed: ParsedArgs = { help: false, dryRun: false, targetPath: null };
	for (const arg of process.argv.slice(2)) {
		if (arg === '--help' || arg === '-h') {
			parsed.help = true;
		} else if (arg === '--dry-run') {
			parsed.dryRun = true;
		} else if (!arg.startsWith('-')) {
			if (parsed.targetPath !== null) {
				console.error(`Unexpected positional argument: ${arg}`);
				console.error(HELP_TEXT);
				process.exit(2);
			}
			parsed.targetPath = arg;
		} else {
			console.error(`Unknown argument: ${arg}`);
			console.error(HELP_TEXT);
			process.exit(2);
		}
	}
	return parsed;
};

const stripQuotes = (value: string): string => value.trim().replace(/^['"]|['"]$/g, '');

const resolveTargetPath = (positional: string | null): string => {
	if (positional) return path.resolve(positional);
	loadDotenv({ path: path.join(repoDir, '.env') });
	const envValue = process.env.TARGET_PATH ? stripQuotes(process.env.TARGET_PATH) : '';
	if (envValue) return path.resolve(envValue);
	return path.resolve(repoDir, 'starred_repos');
};

type Status = 'updated' | 'would-update' | 'skipped:not-git' | 'skipped:no-commit';

interface Result {
	name: string;
	status: Status;
	oldTime: Date;
	newTime: Date;
}

const args = parseArgs();
if (args.help) {
	console.log(HELP_TEXT);
	process.exit(0);
}

const root = resolveTargetPath(args.targetPath);
if (!fs.existsSync(root)) {
	console.error(`Root path does not exist: ${root}`);
	process.exit(1);
}

console.log(`Root: ${root}`);

const results: Result[] = [];
let entries: fs.Dirent[];
try {
	entries = fs.readdirSync(root, { withFileTypes: true });
} catch (error) {
	console.error(`Cannot read ${root}: ${(error as Error).message}`);
	process.exit(1);
}

for (const entry of entries) {
	if (!entry.isDirectory()) continue;

	const repoPath = path.join(root, entry.name);
	const gitPath = path.join(repoPath, '.git');

	let oldTime: Date;
	try {
		oldTime = fs.statSync(repoPath).mtime;
	} catch (error) {
		console.warn(`Cannot stat ${repoPath}: ${(error as Error).message}`);
		continue;
	}

	if (!fs.existsSync(gitPath)) {
		results.push({ name: entry.name, status: 'skipped:not-git', oldTime, newTime: oldTime });
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

		if (!args.dryRun) {
			fs.utimesSync(repoPath, commitTime, commitTime);
		}

		results.push({
			name: entry.name,
			status: args.dryRun ? 'would-update' : 'updated',
			oldTime,
			newTime: commitTime,
		});
	} catch {
		results.push({ name: entry.name, status: 'skipped:no-commit', oldTime, newTime: oldTime });
	}
}

const changed = results.filter((r) => r.status === 'updated' || r.status === 'would-update');
const skipped = results.filter((r) => r.status !== 'updated' && r.status !== 'would-update');
const changedLabel = args.dryRun ? 'Would update' : 'Updated';

console.log(`${changedLabel}: ${changed.length}`);
console.log(`Skipped: ${skipped.length}`);

const formatTable = <T extends Record<string, string>>(
	rows: T[],
	columns: Array<keyof T & string>
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

if (changed.length > 0) {
	const toRow = (r: Result) => ({
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
