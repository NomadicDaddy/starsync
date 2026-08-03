/**
 * Renders the attribution appendix: every package in the runtime closure, with the license text
 * and NOTICE it actually ships.
 *
 * This is the document that carries the obligations. The summary file states which licenses are
 * involved; this one reproduces each package's own copyright line and terms, which is what MIT
 * ("the above copyright notice ... shall be included"), BSD, ISC and Apache-2.0 (license copy plus
 * NOTICE) all require of a redistribution.
 */

import { type ClosurePackage, packagesWithoutLicenseText } from './closure.ts';

export interface NoticesOptions {
	closure: ClosurePackage[];
	intro: string;
	title: string;
}

/** Fences license text so a stray heading or table inside it cannot break the document. */
function fence(text: string): string {
	const longest = [...text.matchAll(/^`{3,}/gm)].reduce(
		(max, match) => Math.max(max, match[0].length),
		0,
	);
	const delimiter = '`'.repeat(Math.max(3, longest + 1));
	return `${delimiter}text\n${text}\n${delimiter}`;
}

export function renderNotices(options: NoticesOptions): string {
	const { closure, intro, title } = options;
	const missing = packagesWithoutLicenseText(closure);

	const sections: string[] = [
		`# ${title}`,
		'',
		intro.trim(),
		'',
		`This appendix covers **${closure.length}** third-party package versions in the runtime closure.`,
		'',
	];

	if (missing.length > 0) {
		sections.push(
			'## Packages shipping no license file',
			'',
			'These packages declare a license but ship no LICENSE file of their own, so there is no',
			'copyright line to reproduce. Their terms are the standard text of the declared license,',
			'reproduced in the summary document; the copyright holder is the package author.',
			'',
			...missing.map((pkg) => `- \`${pkg.name}@${pkg.version}\` (${pkg.license})`),
			'',
		);
	}

	sections.push('## Package notices', '');

	for (const pkg of closure) {
		sections.push(`### ${pkg.name}@${pkg.version}`, '', `License: ${pkg.license}`, '');
		if (pkg.licenseText) sections.push(fence(pkg.licenseText), '');
		if (pkg.noticeText) sections.push('NOTICE:', '', fence(pkg.noticeText), '');
	}

	return `${sections
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim()}\n`;
}
