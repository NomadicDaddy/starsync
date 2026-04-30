import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse arguments
const args = process.argv.slice(2);
let rootPath = '';
let dryRun = false;

for (const arg of args) {
	if (
		arg.toLowerCase() === '--dryrun' ||
		arg.toLowerCase() === '-dryrun' ||
		arg.toLowerCase() === '--dry-run'
	) {
		dryRun = true;
	} else if (!arg.startsWith('-') && !rootPath) {
		rootPath = arg;
	}
}

// Determine root path
if (!rootPath) {
	config({ path: path.join(__dirname, '..', '.env') });
	rootPath = process.env.TARGET_PATH?.trim().replace(/^['"]|['"]$/g, '') || '';
}

if (!rootPath) {
	rootPath = path.join(__dirname, '..', 'starred_repos');
}

const root = path.resolve(rootPath);
if (!fs.existsSync(root)) {
	console.error(`Root path does not exist: ${root}`);
	process.exit(1);
}

console.log(`Root: ${root}`);

interface Result {
	name: string;
	status: string;
	oldTime: Date;
	newTime: Date;
}

const results: Result[] = [];
const entries = fs.readdirSync(root, { withFileTypes: true });

for (const entry of entries) {
	if (!entry.isDirectory()) continue;

	const repoPath = path.join(root, entry.name);
	const gitPath = path.join(repoPath, '.git');
	const stats = fs.statSync(repoPath);
	const oldTime = stats.mtime;

	if (!fs.existsSync(gitPath)) {
		results.push({
			name: entry.name,
			status: 'skipped:not-git',
			oldTime,
			newTime: oldTime,
		});
		continue;
	}

	try {
		const iso = execSync(`git -C "${repoPath}" log -1 --format=%cI`, {
			stdio: ['pipe', 'pipe', 'ignore'],
		})
			.toString()
			.trim();
		if (!iso) {
			throw new Error('No commit found');
		}

		const commitTime = new Date(iso);
		if (isNaN(commitTime.getTime())) {
			throw new Error('Invalid date');
		}

		if (!dryRun) {
			// Update both access time and modified time
			fs.utimesSync(repoPath, commitTime, commitTime);
		}

		results.push({
			name: entry.name,
			status: dryRun ? 'would-update' : 'updated',
			oldTime,
			newTime: commitTime,
		});
	} catch (error) {
		results.push({
			name: entry.name,
			status: 'skipped:no-commit',
			oldTime,
			newTime: oldTime,
		});
	}
}

const changed = results.filter((r) => r.status === 'updated' || r.status === 'would-update');
const skipped = results.filter((r) => r.status !== 'updated' && r.status !== 'would-update');
const changedLabel = dryRun ? 'Would update' : 'Updated';

console.log(`${changedLabel}: ${changed.length}`);
console.log(`Skipped: ${skipped.length}`);

function formatTable(data: any[], columns: string[]) {
	if (data.length === 0) return;

	// Create headers
	const cols = columns.map((col) => {
		const maxLength = Math.max(col.length, ...data.map((item) => String(item[col]).length));
		return { name: col, length: maxLength };
	});

	// Print headers
	const headerRow = cols.map((c) => c.name.padEnd(c.length)).join(' | ');
	console.log(headerRow);
	console.log(cols.map((c) => '-'.repeat(c.length)).join('-+-'));

	// Print rows
	for (const row of data) {
		const rowStr = cols.map((c) => String(row[c.name]).padEnd(c.length)).join(' | ');
		console.log(rowStr);
	}
}

if (changed.length > 0) {
	console.log('\nOldest folder timestamps:');
	const oldest = [...changed]
		.sort((a, b) => a.newTime.getTime() - b.newTime.getTime())
		.slice(0, 10)
		.map((r) => ({
			Name: r.name,
			NewTime: r.newTime.toLocaleString(),
			OldTime: r.oldTime.toLocaleString(),
		}));
	formatTable(oldest, ['Name', 'NewTime', 'OldTime']);

	console.log('\nNewest folder timestamps:');
	const newest = [...changed]
		.sort((a, b) => b.newTime.getTime() - a.newTime.getTime())
		.slice(0, 10)
		.map((r) => ({
			Name: r.name,
			NewTime: r.newTime.toLocaleString(),
			OldTime: r.oldTime.toLocaleString(),
		}));
	formatTable(newest, ['Name', 'NewTime', 'OldTime']);
}

if (skipped.length > 0) {
	console.log('\nSkipped folders:');
	const skippedData = skipped.map((r) => ({ Name: r.name, Status: r.status }));
	formatTable(skippedData, ['Name', 'Status']);
}
