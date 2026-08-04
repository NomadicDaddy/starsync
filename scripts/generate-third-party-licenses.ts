/**
 * Generates THIRD_PARTY_LICENSES.md and THIRD_PARTY_NOTICES.md from the locked dependency graph.
 *
 *   bun scripts/generate-third-party-licenses.ts           # write the files
 *   bun scripts/generate-third-party-licenses.ts --check   # fail if they drifted
 *
 * The summary enumerates the declared dependencies and the license distribution of everything the
 * lockfile resolves beneath them; the appendix reproduces each package's own notice text. --check
 * runs from `check:licenses`, so smoke:qc and the pre-commit hook enforce alignment with bun.lock.
 *
 * This is also where license policy is actually enforced: a license family with no reviewed notice
 * text, or a copyleft package with no recorded distribution analysis, fails the run.
 */

import { join } from 'node:path';
import { cwd, exit } from 'node:process';

import { collectRuntimeClosure, summarizeClosure } from './lib/third-party-licenses/closure.ts';
import { collectDirectDependencies, internalNames } from './lib/third-party-licenses/collect.ts';
import {
	DEPENDENCIES_HEADING,
	type GeneratedDocuments,
	intro,
	NOTICES_INTRO,
	scopeSections,
} from './lib/third-party-licenses/documents.ts';
import { renderNotices } from './lib/third-party-licenses/notices-doc.ts';
import { FLAGGED_ANALYSIS } from './lib/third-party-licenses/notices.ts';
import { formatMarkdown, render, unreviewedLicenses } from './lib/third-party-licenses/render.ts';

const OUTPUT = 'THIRD_PARTY_LICENSES.md';
const NOTICES_OUTPUT = 'THIRD_PARTY_NOTICES.md';
const DISPLAY_NAME = 'StarSync';

/**
 * package.json carries a slug ("starsync"); the prose wants the brand ("StarSync"), whose casing
 * the slug does not encode — deriving it by upper-casing the first letter yields "Starsync". The
 * two are still checked against each other case-insensitively, so a rename fails the run rather
 * than leaving these documents branded with a name the package no longer uses.
 */
function displayName(slug: string): string {
	if (slug.toLowerCase() !== DISPLAY_NAME.toLowerCase()) {
		console.error(`package.json name "${slug}" does not match DISPLAY_NAME "${DISPLAY_NAME}".`);
		console.error('Update DISPLAY_NAME in scripts/generate-third-party-licenses.ts.');
		exit(1);
	}
	return DISPLAY_NAME;
}

function flaggedNoteFor(flagged: { license: string; name: string }[]): string {
	const unanalyzed = flagged.filter((entry) => !(entry.name in FLAGGED_ANALYSIS));
	if (unanalyzed.length > 0) {
		console.error('Copyleft/weak-copyleft package in the runtime closure with no analysis:');
		for (const entry of unanalyzed) console.error(`  - ${entry.name} (${entry.license})`);
		console.error('Review how it is distributed and add an entry to FLAGGED_ANALYSIS.');
		exit(1);
	}
	return flagged.map((entry) => FLAGGED_ANALYSIS[entry.name]).join('\n\n');
}

function reportUnresolved(label: string, unresolved: string[]): void {
	if (unresolved.length === 0) return;
	// A package we cannot locate is a package whose license we never read. That is a hole in the
	// attribution, so it fails the generator rather than shrinking the appendix.
	console.error(`${label} (run \`bun install\` first):`);
	for (const entry of unresolved) console.error(`  - ${entry}`);
	exit(1);
}

function assertReviewed(attributed: { license: string; name: string }[]): void {
	const unreviewed = unreviewedLicenses(attributed);
	if (unreviewed.length === 0) return;

	console.error('Dependency uses a license with no reviewed notice text:');
	for (const license of unreviewed) {
		const users = attributed.filter((entry) => entry.license === license).map((e) => e.name);
		console.error(`  - ${license} (${[...new Set(users)].join(', ')})`);
	}
	console.error(
		'Add it to scripts/lib/third-party-licenses/notices.ts after reviewing its terms.',
	);
	exit(1);
}

export async function generate(root: string): Promise<GeneratedDocuments> {
	const { dependencies, unresolved } = await collectDirectDependencies(root);
	reportUnresolved('Cannot resolve installed package(s)', unresolved);

	const { closure, unresolved: unresolvedClosure } = await collectRuntimeClosure(
		root,
		await internalNames(root),
	);
	reportUnresolved('Cannot resolve packages in the runtime closure', unresolvedClosure);

	assertReviewed([...dependencies, ...closure]);

	// Identity comes from the manifest, not from a hardcoded "StarSync"/"MIT", so a rename or a
	// license change cannot leave these documents asserting something the package no longer says.
	const identity = (await Bun.file(join(root, 'package.json')).json()) as {
		license?: string;
		name?: string;
		packageManager?: string;
	};
	const appName = displayName(identity.name ?? '');
	const appLicense = identity.license ?? 'UNKNOWN';

	const graph = summarizeClosure(closure);
	const summary = render({
		dependencies,
		dependenciesHeading: DEPENDENCIES_HEADING,
		flaggedNote: flaggedNoteFor(graph.flagged),
		graph,
		intro: intro(appName, appLicense),
		scopeSections,
		title: 'Third-Party Licenses',
	});

	const notices = renderNotices({
		closure,
		intro: NOTICES_INTRO,
		title: 'Third-Party Notices',
	});

	return {
		notices: await formatMarkdown(notices, root),
		summary: await formatMarkdown(summary, root),
	};
}

async function main(): Promise<void> {
	const root = cwd();
	const check = Bun.argv.includes('--check');
	const generated = await generate(root);
	const documents = [
		{ content: generated.summary, name: OUTPUT },
		{ content: generated.notices, name: NOTICES_OUTPUT },
	];

	if (!check) {
		for (const document of documents) {
			await Bun.write(join(root, document.name), document.content);
			console.log(`Wrote ${document.name}`);
		}
		return;
	}

	for (const document of documents) {
		const committed = await Bun.file(join(root, document.name))
			.text()
			.catch(() => '');

		if (committed !== document.content) {
			console.error(`${document.name} is out of date with the locked dependency graph.`);
			console.error('Run `bun run licenses:generate` and commit the result.');
			exit(1);
		}
	}

	console.log(`${OUTPUT} and ${NOTICES_OUTPUT} match the locked dependency graph.`);
}

if (import.meta.main) {
	await main();
}
