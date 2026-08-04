/**
 * Notice text reproduced for each license family that appears in StarSync's
 * runtime dependency closure.
 *
 * Permissive licenses that require the license text to travel with the
 * distribution (MIT, ISC, BSD, 0BSD, BlueOak) have their terms reproduced in
 * full. Apache-2.0 and the public-domain dedications are referenced by
 * canonical URL, which their terms permit, with the attribution that is
 * required.
 *
 * This is a reviewed reference table, not a list of licenses currently in use:
 * entries with no present dependency stay so that an ordinary version bump does
 * not fail the generator. A license family present in the dependency set but
 * absent from this map is a hard error there: an unreviewed license must not be
 * silently summarized as if its obligations were known.
 */

export interface Notice {
	/** Prose shown under the heading. Reproduced license text uses blockquotes. */
	body: string;
	heading: string;
}

export const NOTICES: Record<string, Notice> = {
	'0BSD': {
		body: [
			'> Permission to use, copy, modify, and/or distribute this software for any',
			'> purpose with or without fee is hereby granted.',
			'>',
			'> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES',
			'> WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF',
			'> MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY',
			'> SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES',
			'> WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION',
			'> OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN',
			'> CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.',
		].join('\n'),
		heading: 'BSD Zero Clause License',
	},
	'Apache-2.0': {
		body: [
			'These packages are licensed under the Apache License, Version 2.0. A copy of',
			'the license is available at <https://www.apache.org/licenses/LICENSE-2.0>.',
			'The software is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR',
			'CONDITIONS OF ANY KIND, either express or implied. Where a package ships a',
			'`NOTICE` file, that file travels with the package in `node_modules` and its',
			'attributions apply.',
		].join('\n'),
		heading: 'Apache License 2.0',
	},
	'BlueOak-1.0.0': {
		body: [
			'These packages are licensed under the Blue Oak Model License 1.0.0, available',
			'at <https://blueoakcouncil.org/license/1.0.0>. It is a permissive license: it',
			'grants copyright and patent permission to use, modify, and redistribute the',
			'software, on the conditions that the license text travels with copies of the',
			'software and that the contributors are not held liable. The software is',
			'provided "as is" without any warranty.',
		].join('\n'),
		heading: 'Blue Oak Model License 1.0.0',
	},
	'BSD-2-Clause': {
		body: [
			'> Redistribution and use in source and binary forms, with or without',
			'> modification, are permitted provided that the following conditions are met:',
			'>',
			'> 1. Redistributions of source code must retain the above copyright notice,',
			'>    this list of conditions and the following disclaimer.',
			'> 2. Redistributions in binary form must reproduce the above copyright notice,',
			'>    this list of conditions and the following disclaimer in the documentation',
			'>    and/or other materials provided with the distribution.',
			'>',
			'> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"',
			'> AND ANY EXPRESS OR IMPLIED WARRANTIES ARE DISCLAIMED. IN NO EVENT SHALL THE',
			'> COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,',
			'> INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES ARISING IN ANY WAY',
			'> OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH',
			'> DAMAGE.',
		].join('\n'),
		heading: 'BSD 2-Clause License',
	},
	'BSD-3-Clause': {
		body: [
			'> Redistribution and use in source and binary forms, with or without',
			'> modification, are permitted provided that the following conditions are met:',
			'>',
			'> 1. Redistributions of source code must retain the above copyright notice,',
			'>    this list of conditions and the following disclaimer.',
			'> 2. Redistributions in binary form must reproduce the above copyright notice,',
			'>    this list of conditions and the following disclaimer in the documentation',
			'>    and/or other materials provided with the distribution.',
			'> 3. Neither the name of the copyright holder nor the names of its',
			'>    contributors may be used to endorse or promote products derived from this',
			'>    software without specific prior written permission.',
			'>',
			'> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"',
			'> AND ANY EXPRESS OR IMPLIED WARRANTIES ARE DISCLAIMED. IN NO EVENT SHALL THE',
			'> COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,',
			'> INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES ARISING IN ANY WAY',
			'> OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH',
			'> DAMAGE.',
		].join('\n'),
		heading: 'BSD 3-Clause License',
	},
	'CC0-1.0': {
		body: [
			'These packages are offered under the Creative Commons CC0 1.0 Universal',
			'public-domain dedication, available at',
			'<https://creativecommons.org/publicdomain/zero/1.0/legalcode>. To the extent',
			'possible under law, the authors waive copyright and related rights; CC0 also',
			'includes a fallback license and is provided without warranties.',
		].join('\n'),
		heading: 'CC0 1.0 Universal',
	},
	ISC: {
		body: [
			'> Permission to use, copy, modify, and/or distribute this software for any',
			'> purpose with or without fee is hereby granted, provided that the above',
			'> copyright notice and this permission notice appear in all copies.',
			'>',
			'> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH',
			'> REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND',
			'> FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,',
			'> INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM',
			'> LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR',
			'> OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR',
			'> PERFORMANCE OF THIS SOFTWARE.',
		].join('\n'),
		heading: 'ISC License',
	},
	MIT: {
		body: [
			'Each MIT-licensed dependency is provided under the standard MIT License, with',
			'copyright held by the respective package authors as stated in that package.',
			'The permission notice and warranty disclaimer below apply to each of them.',
			'',
			'> Permission is hereby granted, free of charge, to any person obtaining a copy',
			'> of this software and associated documentation files (the "Software"), to deal',
			'> in the Software without restriction, including without limitation the rights',
			'> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
			'> copies of the Software, and to permit persons to whom the Software is',
			'> furnished to do so, subject to the following conditions:',
			'>',
			'> The above copyright notice and this permission notice shall be included in',
			'> all copies or substantial portions of the Software.',
			'>',
			'> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
			'> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
			'> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
			'> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
			'> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
			'> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
			'> SOFTWARE.',
		].join('\n'),
		heading: 'MIT License',
	},
	'MIT-0': {
		body: [
			'The MIT No Attribution license grants the same permissions as MIT without the',
			'requirement to reproduce the copyright notice. The text is available at',
			'<https://github.com/aws/mit-0>. The software is provided "as is", without',
			'warranty of any kind.',
		].join('\n'),
		heading: 'MIT No Attribution',
	},
};

/**
 * Reviewed distribution analysis for copyleft / weak-copyleft packages that reach the distributed
 * set, keyed by the exact package@version shown in the closure. The generator hard-errors on any
 * such package with no entry here, so a distributor cannot ship copyleft code without having
 * recorded how its obligations are met, and a version bump re-triggers the review by design.
 *
 * Empty today: StarSync's closure is entirely permissive. If one appears, record here how its
 * obligations are met given that StarSync distributes no third-party code in its own tarball; the
 * consumer's resolver installs the closure.
 */
export const FLAGGED_ANALYSIS: Record<string, string> = {};
