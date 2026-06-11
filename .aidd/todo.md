# TODO List — StarSync

## High Priority

- [ ] **Replace dotenv with Bun-native env** — DONE (commit `c92c9c6`) — feature JSON may need status confirmation
- [ ] **Export cloneOrPull for testability** — `src/index.ts:84` private function, cannot be unit-tested → `audit-architecture-1781133983-cloneorpull-function-is-private-and-untestable`
- [ ] **Extract duplicate utility code** — `stripQuotes` and `resolveTargetPath` duplicated between `src/index.ts` and `scripts/set-folder-dates.ts` → `audit-reorg-1781133983-duplicate-utility-code-across-src-index-ts-and-scripts-set-folder-dates-ts-shoul`

## Medium Priority

- [ ] **Fix bare catch block** — `scripts/set-folder-dates.ts:135` silently swallows git log / utimesSync errors → `audit-code-quality-1781133983-src-index-ts-and-scripts-set-folder-dates-ts-have-identical-eslint-config-js-for`
- [ ] **Remove dead `frontend/` directory** — only contains orphaned `eslint.config.js`, no source files → `audit-dead-code-1781133983-entire-frontend-directory-is-dead-orphaned-eslint-config-js-with-no-source-files`
- [ ] **Delete misleading `.nvmrc`** — says `24` but project uses Bun, not Node/nvm → `audit-code-quality-1781133983-misleading-nvmrc-file-says-24-but-project-uses-bun-not-node-nvm`
- [ ] **Remove `prettier-plugin-tailwindcss`** — dead dependency, no Tailwind usage → `audit-code-quality-1781133983-prettier-plugin-tailwindcss-in-prettierrc-and-package-json-but-tailwind-is-not-u`
- [ ] **Add cloneOrPull remote URL verification** — name-only matching can misidentify repos → `audit-logic-1781133983-cloneorpull-determines-repo-existence-by-name-match-but-doesn-t-verify-git-integ`
- [ ] **Add runStarsync test coverage** — main orchestrator function has zero test coverage → `audit-testing-1781133983-no-test-coverage-for-runstarsync-orchestration-function`

## Low Priority

- [ ] **Deduplicate `.gitattributes`** — multiple duplicate entries (`*.json`, `*.md`, `*.yml`, `*.yaml`, `*.zip`) → `audit-code-quality-1781133983-duplicate-entries-in-gitattributes`

## Technical Debt

- [ ] ~~`starred-repo-sync/feature.json` notes still mention "via dotenv"~~ — FIXED in this session (updated to "Bun-native .env auto-loading")
- [ ] `bun` not available in CI/agent environment — `smoke:qc` and `bun test` cannot be verified remotely
