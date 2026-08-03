# Third-Party Licenses

StarSync is licensed under the [MIT License](./LICENSE). This document records the license
inventory of the npm dependencies this repository declares and of the closure `bun.lock` resolves
for them. Package-specific terms are reproduced in
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

Read the scope section below before treating this as a notice for anything you received: the
published StarSync package contains no third-party code at all, so this inventory describes what an
install pulls in alongside it, not what the tarball redistributes.

## Runtime dependencies

| Package                                                      | Version | License |
| ------------------------------------------------------------ | ------- | ------- |
| [@octokit/rest](https://www.npmjs.com/package/@octokit/rest) | 22.0.1  | MIT     |

## Required notices by license family

### MIT License

Applies to: @octokit/rest.

Each MIT-licensed dependency is provided under the standard MIT License, with
copyright held by the respective package authors as stated in that package.
The permission notice and warranty disclaimer below apply to each of them.

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Runtime closure

The table above enumerates the dependencies this repository declares. The lockfile-resolved
closure follows everything they pull in transitively and covers
**18** third-party package versions (16 unique
names), including any optional packages the lockfile resolves for platforms other than the
one generating this file. Development-only tooling is excluded. Its license distribution is:

| License    | Packages |
| ---------- | -------- |
| MIT        | 16       |
| Apache-2.0 | 1        |
| ISC        | 1        |

No copyleft or weak-copyleft licensed package (GPL, AGPL, SSPL, EUPL, CDDL, OSL,
MPL) appears in this closure. Build tooling is a separate question: it is never
installed by a consumer, so it is not inventoried here.

## Scope

- **The published package redistributes no third-party code.** `bun run build:bundle` passes
  `--packages=external`, so `dist/cli.js` and `dist/index.js` contain first-party source only
  and `import` their dependencies at runtime. The tarball ships those two bundles, the type
  declarations, `README.md` and `LICENSE`. Neither this file nor the notices appendix is
  included, deliberately: a consumer's own resolver decides which versions of these packages it
  installs, so a copy of this repository's lockfile inventory travelling inside the tarball would
  describe versions the consumer may not have.
- **The closure is resolved from the lockfile, not from `node_modules`.** It covers the declared
  production dependencies transitively and includes optional packages resolved for platforms other
  than the one generating this file, so it can over-include rather than under-report.
- **Development and build tooling is not inventoried.** It is a devDependency: it is never
  installed by a consumer of the published package and is not part of any artifact.

## Not covered: the compiled single-file executable

`bun run compile` produces a single-file executable in `dist/`. That artifact is different in
kind from the published npm package: it embeds the JavaScript of the whole runtime closure above
_and_ the Bun runtime, which statically links libraries under the LGPL — JavaScriptCore/WebKit
(LGPL-2) and TinyCC (LGPL-2.1) among them.

StarSync does not publish that executable; `compile` exists for local use. Anyone who does
distribute it takes on the obligations that come with it: passing on the license texts and
copyright lines in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md), reproducing Bun's own
license, and satisfying the LGPL's source and relink requirements for the statically linked
components. Bun is MIT and published at <https://github.com/oven-sh/bun> (this repository pins
`bun@1.3.14`, tagged `bun-v1.3.14`); the patched WebKit/JavaScriptCore it links
is at <https://github.com/oven-sh/webkit>, and TinyCC is at <https://github.com/tinycc/tinycc>.
StarSync's own source is MIT, so nothing here restricts that. A distributor must preserve the
exact corresponding source rather than rely on those upstream locations remaining unchanged.

## Regenerating this file

This document is generated from the locked dependency graph. Run
`bun run licenses:generate` after changing dependencies, and commit the result.
`bun run check:licenses` (part of `smoke:qc` and the pre-commit hook) regenerates it in
memory and fails when the committed copy no longer matches what the lockfile resolves.
