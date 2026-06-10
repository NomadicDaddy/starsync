# Feature Review Report — starsync

**Date**: 2026-06-10 (review #3, first with backlog audit features)
**Project**: starsync
**Stack**: Bun + TypeScript CLI tool (Elysia/Drizzle/React NOT used — this is a pure CLI app)
**Features reviewed**: 12 backlog / 19 total
**Issues found**: 14 (0 conflicts, 1 contradiction, 8 vague, 0 duplications, 5 minor)

---

## Phase 1: Discover & Load

- **Total features found**: 19
- **Template features (skipped)**: 0 (no `spernakit_version` field in any feature)
- **Backlog features (reviewed)**: 12 (all audit-sourced, all `passes: false`)
- **Completed features**: 7 (all `passes: true`, not reviewed individually)

## Phase 2: Codebase Conventions

### Project Structure
- **Source layout**: `src/index.ts` + `src/cli.ts` (core), `scripts/set-folder-dates.ts` (companion), `test/index.test.ts`
- **No backend/frontend split** — pure CLI tool
- **No ORM, no routes, no controllers, no pages**

### Backend Conventions (N/A — CLI tool)
- No HTTP framework, no route registration, no services/controllers pattern
- Uses `execFileSync('git', [...])` for git operations
- Uses `@octokit/rest` for GitHub API
- Uses `dotenv` for env loading (currently)

### Export Convention
- Named exports only (ESLint `no-default-export` rule)
- `import/no-default-export: 'error'` in eslint.config.js

### Lint Rules (relevant)
- Catch variable must be named `err` (`no-restricted-syntax` at eslint.config.js:56-61)
- No default exports
- No `any` types (`@typescript-eslint/no-explicit-any: 'error'`)

### Testing
- `bun test` (Bun native test runner)
- No vitest, jest, or @testing-library

### Quality Gate
- `bun run smoke:qc` → typecheck + lint + format:check

### Completed Feature Quality Bar (3 samples reviewed)
- `starred-repo-sync`: 7 spec lines, all concrete verification steps with exit codes and specific behaviors
- `cli-argument-parsing`: 5 spec lines, all concrete with specific flags and expected behaviors
- `unit-test-suite`: 5 spec lines, all concrete with specific test categories

### Existing Functionality Map

| Domain | Files | Key Functions |
|--------|-------|---------------|
| Core sync engine | `src/index.ts`, `src/cli.ts` | `runStarsync`, `cloneOrPull` (private), `parseArgs`, `resolveTargetPath`, `listFolders`, `stripQuotes` |
| Folder date utility | `scripts/set-folder-dates.ts` | standalone script with `parseArgs`, `resolveTargetPath`, `stripQuotes` (duplicated) |
| Tests | `test/index.test.ts` | tests for `parseArgs`, `resolveTargetPath`, `listFolders`, `stripQuotes` |
| Build/quality | `package.json`, `eslint.config.js`, `.prettierrc`, `tsconfig.json` | `smoke:qc`, `build`, `compile` |

### Remediation Review
- No `.aidd/remediation-review.md` found — skipped

---

## Phase 3: Analysis Results

### CONTRADICTIONS (risks incorrect implementation)

#### Replace dotenv with Bun-native env (`audit-security-1781133982-github-personal-access-token-committed-to-env-file-in-version-control`)

- **Title says "committed to .env file in version control"** but description correctly states the .env was never committed (`git log --all -- .env` returns empty, `.gitignore` excludes `.env`). The title is misleading and contradicts the verified description.

### VAGUE (underspecified — expanded)

#### cloneOrPull private and untestable (`audit-architecture-1781133983-cloneorpull-function-is-private-and-untestable`)

- **Spec line 2**: "Add unit tests for cloneOrPull covering: successful clone, successful pull, clone failure, pull failure" — VAGUE: does not specify what mock mechanism to use for `execFileSync` or what the mock should return for each case
- **Missing**: No `bun test` or `bun run smoke:qc` verification step
- **Meta-instruction**: "IMPORTANT: After resolving this finding, locate the feature.json file(s)..." — this is not a verifiable spec step; should be converted to a concrete instruction naming the specific feature to update (`starred-repo-sync`)

#### Misleading .nvmrc (`audit-code-quality-1781133983-misleading-nvmrc-file-says-24-but-project-uses-bun-not-node-nvm`)

- **Spec line 3**: "If Node.js version pinning is desired, document the Node version requirement..." — VAGUE: "If ... is desired" is a conditional that doesn't specify what to do unconditionally. Should verify that the engines field already documents this, rather than making a conditional recommendation.
- **Meta-instruction**: Same "IMPORTANT: After resolving this finding..." issue as above

#### Bare catch block in set-folder-dates.ts (`audit-code-quality-1781133983-src-index-ts-and-scripts-set-folder-dates-ts-have-identical-eslint-config-js-for`)

- **Spec line 3**: "Consider distinguishing between 'skipped:no-commit' and 'skipped:error'" — VAGUE: "Consider" is a banned action verb per ingredient rules. Should either specify this as a required change or omit it.
- **Missing**: No `bun test` verification step

#### cloneOrPull name-only matching (`audit-logic-1781133983-cloneorpull-determines-repo-existence-by-name-match-but-doesn-t-verify-git-integ`)

- **Spec line 2**: "remove or rename the existing directory first, or skip with a warning" — VAGUE: doesn't specify which approach to take. Should pick one concrete action.
- **Missing**: No `bun test` or `bun run smoke:qc` verification step

#### Synchronous filesystem operations (`audit-security-1781133982-synchronous-filesystem-operations-block-the-event-loop-during-large-syncs`)

- **Spec line 6**: "the sync loop can use Promise.all with a concurrency limiter for parallel clone/pull operations" — VAGUE: doesn't specify what limiter library, what concurrency limit, or whether this is in-scope for this feature or a future enhancement.
- **Missing**: No `bun test` or `bun run smoke:qc` verification step

#### Replace dotenv (`audit-security-1781133982-github-personal-access-token-committed-to-env-file-in-version-control`)

- **Missing**: No `bun test` verification step

#### Duplicate utility code extraction (`audit-reorg-1781133983-duplicate-utility-code-across-src-index-ts-and-scripts-set-folder-dates-ts-shoul`)

- **Missing**: No `bun test` verification step

#### runStarsync test coverage (`audit-testing-1781133983-no-test-coverage-for-runstarsync-orchestration-function`)

- **Missing**: No `bun run smoke:qc` verification step

### MINOR (convention alignment)

#### cloneOrPull name-only matching (`audit-logic-1781133983-cloneorpull-determines-repo-existence-by-name-match-but-doesn-t-verify-git-integ`)

- **Undeclared dependency**: This feature modifies `cloneOrPull` in `src/index.ts`. If `audit-architecture-...cloneorpull-function-is-private` runs first (exports the function), the line numbers and code context will change. Should declare a dependency on the architecture export feature.

#### Duplicate utility code extraction (`audit-reorg-1781133983-duplicate-utility-code-across-src-index-ts-and-scripts-set-folder-dates-ts-shoul`)

- **Undeclared dependency**: This feature extracts code from `scripts/set-folder-dates.ts`. If the bare-catch-block feature runs first (modifies the same file), the code context changes. Should declare a dependency on the bare-catch-block feature.

#### Replace dotenv (`audit-security-1781133982-github-personal-access-token-committed-to-env-file-in-version-control`)

- **Undeclared dependency**: This feature removes `dotenv` imports from both `src/index.ts` and `scripts/set-folder-dates.ts`. If the reorg feature runs first (extracts shared utils to `src/lib/cli-utils.ts`), the import locations change. Should declare a dependency on the reorg feature.

#### Synchronous filesystem operations (`audit-security-1781133982-synchronous-filesystem-operations-block-the-event-loop-during-large-syncs`)

- **Undeclared dependency**: This feature converts `cloneOrPull` to async and modifies shared utility code. Should declare dependencies on both the architecture export feature (cloneOrPull must be exported first for async conversion to be clean) and the reorg feature (shared utils should be extracted before async conversion).

#### runStarsync test coverage (`audit-testing-1781133983-no-test-coverage-for-runstarsync-orchestration-function`)

- **Undeclared dependency**: Tests for `runStarsync` will be easier to write if `cloneOrPull` is already exported (architecture export feature). Should declare a dependency.

---

## Phase 4: Cross-Feature Issues

### File Conflict Analysis

**`src/index.ts`** is modified by 4 backlog features:
1. Architecture export (exports `cloneOrPull`)
2. Logic remote-check (adds URL validation to `cloneOrPull`)
3. Dotenv removal (removes `loadDotenv()` call)
4. Async conversion (makes `cloneOrPull` and helpers async)

**Execution order**: Architecture export → Logic remote-check → Reorg → Dotenv removal → Async conversion

**`scripts/set-folder-dates.ts`** is modified by 4 backlog features:
1. Bare catch block (adds `err` variable and logging)
2. Reorg (extracts shared utils to `src/lib/cli-utils.ts`)
3. Dotenv removal (removes `loadDotenv()` call)
4. Async conversion (converts to async fs operations)

**Execution order**: Bare catch block → Reorg → Dotenv removal → Async conversion

**`test/index.test.ts`** is modified by 2 backlog features:
1. Architecture export (adds `cloneOrPull` tests)
2. runStarsync tests (adds `runStarsync` tests)

**No route conflicts** (N/A — CLI tool, no HTTP routes)

### Missing Features
- No gaps detected — audit findings cover identified issues, no missing CRUD/page gaps

### Recommended Execution Order
1. **P1**: `audit-security-dotenv` (critical security — but has dependency, see below)
2. **P3**: `audit-architecture-cloneorpull-export` (enables testing, logic fix, async)
3. **P3**: `audit-reorg-shared-utils` (reduces duplication before async conversion)
4. **P3**: `audit-security-sync-fs` (async conversion — largest refactor)
5. **P4**: Bare catch block, .nvmrc, tailwindcss, frontend dir, cloneOrPull name-match, runStarsync tests
6. **P5**: .gitattributes dedup (lowest priority housekeeping)

### Dependency Chain Established
```
audit-architecture-cloneorpull-export (no deps)
    ├── audit-testing-runstarsync (depends on export)
    └── audit-security-sync-fs (depends on export + reorg)

audit-code-quality-bare-catch (no deps)
    └── audit-reorg-shared-utils (depends on bare-catch)
        └── audit-security-dotenv (depends on reorg)

audit-code-quality-gitattributes (no deps)
audit-code-quality-nvmrc (no deps)
audit-code-quality-tailwindcss (no deps)
audit-dead-code-frontend (no deps)
audit-logic-cloneorpull-namematch (no deps)
```

---

## Phase 6: Auto-Fix Summary

| Feature | Issues Fixed | Changes |
| ------- | ------------ | ------- |
| cloneOrPull private and untestable | 4 | Expanded spec with concrete mock instructions, added `bun test` + `bun run smoke:qc` verification, converted meta-instruction to concrete step naming `starred-repo-sync` |
| Misleading .nvmrc | 2 | Removed conditional "If desired" language, replaced with concrete verification of existing engines field, added `bun run smoke:qc` verification |
| Bare catch block in set-folder-dates.ts | 2 | Removed "Consider distinguishing" banned verb, added `bun run lint` verification (explicit check for ESLint catch-variable rule compliance) |
| cloneOrPull name-only matching | 3 | Resolved "remove or rename or skip" vagueness with concrete skip-and-warn approach, added `bun test` + `bun run smoke:qc` verification |
| Duplicate utility code extraction | 2 | Added dependency on bare-catch-block feature, added `bun test` + `bun run smoke:qc` verification |
| Replace dotenv | 3 | Fixed misleading title (was "committed to .env in version control", now "remove unnecessary .env dependency"), added dependency on reorg feature, added `bun test` verification |
| Synchronous filesystem operations | 3 | Resolved Promise.all vagueness (explicitly scoped out as future enhancement), added dependencies on architecture-export + reorg, added `bun test` + `bun run smoke:qc` verification |
| runStarsync test coverage | 2 | Added dependency on architecture-export feature, expanded test cases with concrete mock instructions, added `bun run smoke:qc` verification |

**Total**: 8 features modified, 21 issues resolved

### Features NOT modified (no issues found):
- `audit-code-quality-1781133983-duplicate-entries-in-gitattributes` — spec is clean ✅
- `audit-code-quality-1781133983-prettier-plugin-tailwindcss-...` — spec is clean ✅
- `audit-dead-code-1781133983-entire-frontend-directory-...` — spec is clean ✅

---

## Phase 6.5: Roadmap Assignment

No `.aidd/roadmap.json` exists — assignment skipped.

---

## Phase 7: Pipeline Handoff

- **Features auto-closed as already-implemented**: 0
- **Final feature inventory health**: 19 total / 12 backlog / 7 completed
- **Spec quality**: 8/12 backlog features had vague specs (67%) — above the 30% threshold
- **Recommendation**: Spec quality issues are concentrated in audit-sourced features (vague instructions, missing verification steps). Consider running the native `audit-review` ingredient on the audit definitions that generated these findings to improve spec quality at the source.
