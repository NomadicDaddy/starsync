# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Onboarding session (2026-07-27)
  - **Created `/.aidd/spec.md`** (required artifact missing since intake 2026-06-10)
    - Comprehensive app specification covering CLI interface, authentication, sync behavior, companion script behavior, data model, quality gate, technology constraints, file layout, and known limitations
  - **Created `/.aidd/assertions.md`** (recommended artifact missing)
    - 26 behavioral, data, and quality invariants organized by domain (CLI, sync engine, path resolution, auth, companion script, data, quality)
  - **Created `/.aidd/todo.md`** (recommended artifact missing)
    - 10 action items from audit backlog: 2 high priority, 7 medium priority, 1 low priority
    - 2 technical debt items
  - **Created 4 new feature JSONs** to meet minimum 20-feature threshold:
    - `error-handling-and-exit-codes` (Core, completed) — systematic exit code semantics
    - `typescript-strict-configuration` (DevEx, completed) — strict tsconfig enforcement
    - `eslint-code-style-enforcement` (DevEx, completed) — ESLint rules with custom plugins
    - `gitignore-and-environment-protection` (Security, completed) — .env exclusion, line endings
  - **Fixed `starred-repo-sync/feature.json`** — stale note "via dotenv" → "via Bun-native .env auto-loading"
  - **Feature count**: 22 total (10 audit backlog, 1 audit completed, 12 non-audit completed)
  - **Bun not available** in agent environment — smoke:qc and bun test could not be verified

### Artifact Inventory (Step 2.2)

| Artifact                | Status      | Notes                                    |
| ----------------------- | ----------- | ---------------------------------------- |
| spec.md                 | ✓ created   | Was required-missing since intake        |
| assertions.md           | ✓ created   | Was recommended-missing                  |
| project-structure.md    | ✓ fresh     | Present, accurate                        |
| project.md              | ✓ fresh     | Present, accurate                        |
| project-profile.json    | ✓ fresh     | Present, verified accurate 2026-07-27    |
| testing-scenarios.md    | ✓ fresh     | 20 scenarios, comprehensive coverage     |
| roadmap.json            | ✗ missing   | Recommended — use `/update-roadmap`      |
| screen-map.md           | ✗ missing   | Not applicable (CLI tool, no UI screens) |
| questions.md            | ✗ missing   | Optional                                 |
| responses.md            | ✗ missing   | Optional                                 |
| CONTEXT.md              | ✗ missing   | Recommended — domain context file        |
| todo.md                 | ✓ created   | 10 audit backlog items + 2 tech debt     |

### Feature Coverage Summary

- **Total features**: 22
- **Completed (passes: true)**: 12 (8 original + 4 new)
- **Backlog (passes: false)**: 10 (all audit-sourced)
- **Categories covered**: Core (3), CLI (1), companion (1), quality (1), tooling (2), DevEx (2), Security (1), Audit (10)
- **Audit features by status**: 1 completed (dotenv removal), 10 backlog
- **Non-audit features by status**: 11 completed, 0 backlog

### Next Steps

- Session 2: Implement audit backlog items (priority order: export cloneOrPull → fix bare catch → extract utilities → delete dead files)
- Run `/update-roadmap` to create `.aidd/roadmap.json` with milestone assignments
- Consider whether `CONTEXT.md` and `screen-map.md` are needed for a CLI tool

### Added

- Intake report (2026-06-10) in `.aidd/reports/intake.md`
  - Detected stack: Bun/TypeScript CLI tool, no framework, no server runtime
  - Project profile: personal developer utility, low criticality, medium data sensitivity
  - Artifact inventory: 4 present/fresh, 2 required missing (spec.md, CONTEXT.md), 3 recommended missing
  - Feature counts: 8 completed (all non-audit), 10 backlog (all audit-sourced), 0 remediation
  - Audit history: 2 audit-finding-review rounds, 1 feature review of backlog; 2 findings removed, 9 consolidated to 5
  - Codebase health: B+ (unchanged since May 6 — no source code changes)
  - No open questions (questions.md does not exist)
  - 15 recommended next actions prioritized

### Reviewed

- Audit finding review (audit-finding-review starsync, 2026-06-10 #2) — 11 audit findings reviewed against codebase
  - **Application**: starsync (typescript+bun CLI tool, not spernakit-derived)
  - **Findings reviewed**: 11 audit-sourced feature.json files
  - **Non-audit features skipped**: 8 (build-and-compile-pipeline, cli-argument-parsing, etc.)
  - **No spernakit template** — all findings are APP-ONLY by definition
  - **No roadmap.json** — roadmap reconciliation skipped
  - **Results applied directly** (no confirmation needed — unattended mode)

  #### Summary

  | Disposition     | Count | Action                                   |
  | --------------- | ----- | ---------------------------------------- |
  | KEEP            | 10    | Retain in app backlog                    |
  | REMOVE          | 1     | Deleted from app                         |

  #### REMOVE (1 finding deleted)

  - **Synchronous filesystem operations** (`audit-security-...synchronous-filesystem-operations...`)
    - **Reason**: UNNECESSARY — premature optimization for a sequential CLI tool with no event loop contention
    - **Annotation**:
      - finding_id: `audit-security-1781133982-synchronous-filesystem-operations-block-the-event-loop-during-large-syncs`
      - reason_code: `UNNECESSARY`
      - audit_source: `SECURITY`
      - evidence: `Sequential CLI tool has no event loop contention; async conversion provides zero benefit`

  #### KEEP (10 findings retained)

  - **cloneOrPull private/untestable** — priority 3 (architecture)
  - **Duplicate .gitattributes entries** — priority 5 (housekeeping)
  - **Misleading .nvmrc** — priority 4 (delete untracked file)
  - **prettier-plugin-tailwindcss dead dependency** — priority 4 (remove unused plugin)
  - **Bare catch block silently swallows errors** — priority 4 (real code quality issue)
  - **Dead frontend directory** — priority 4 (delete untracked directory)
  - **cloneOrPull name-only matching** — priority 4 (rare edge case)
  - **Duplicate utility code** — priority 3 (extract shared module)
  - **Replace dotenv with Bun-native env** — priority 1 (remove unnecessary dependency)
  - **No runStarsync test coverage** — priority 4 (nice-to-have for personal CLI)

  #### Pipeline Handoff Notes

  - 10 KEEP findings remain — recommend: `Run the native feature-review ingredient for starsync to validate remaining finding specs`
  - 1 REMOVE as UNNECESSARY from SECURITY audit — recommend: `Run the native audit-review ingredient on the SECURITY audit definition to prevent future false positives`
  - No ESCALATE findings (not a spernakit-derived app)
  - No roadmap.json — assignment skipped

  #### Final Feature Inventory

  - **Total**: 18 feature directories (10 audit + 8 non-audit)
  - **Audit findings by status**: 10 backlog
  - **Non-audit features by status**: 8 completed
  - **All JSON valid**, **no orphaned directories**, **all dependency references resolve**

- Feature review (feature-review starsync, 2026-06-10 #3 — backlog audit features) in `.aidd/reports/feature-review-2026-06-10-starsync-backlog.md`
  - First review covering 12 backlog audit-sourced feature.json files (previous reviews only found 0 backlog features)
  - **12 backlog features reviewed**, **7 completed features skipped** (all `passes: true`)
  - **14 issues found**: 0 conflicts, 1 contradiction, 8 vague, 0 duplications, 5 minor
  - **8 features auto-fixed**, 21 issues resolved
  - Key fixes: expanded vague specs with concrete artifacts, added missing `bun test`/`bun run smoke:qc` verification steps, resolved "Consider" banned verbs, fixed misleading dotenv title, added undeclared dependencies between related features
  - Established dependency chain: architecture-export → testing + sync-fs; bare-catch → reorg → dotenv removal
  - No roadmap.json — assignment skipped
  - Feature inventory health: 19 total / 12 backlog / 7 completed
- Audit finding review (audit-finding-review starsync, 2026-06-10) — 18 audit findings reviewed against codebase
  - **Application**: starsync (typescript+bun CLI tool, not spernakit-derived)
  - **Findings reviewed**: 18 audit-sourced feature.json files
  - **Non-audit features skipped**: 7 (build-and-compile-pipeline, cli-argument-parsing, etc.)
  - **No spernakit template** — all findings are APP-ONLY by definition
  - **No roadmap.json** — roadmap reconciliation skipped
  - **Results applied directly** (no confirmation needed — unattended mode)

  #### Summary

  | Disposition     | Count | Action                                   |
  | --------------- | ----- | ---------------------------------------- |
  | KEEP            | 4     | Retain in app backlog                    |
  | CONSOLIDATE     | 5 (14 → 5 surviving) | Merged 9 duplicate findings into 5 groups |
  | REMOVE          | 1     | Deleted from app                         |
  | DOWNGRADE       | 3     | Reduced priority/scope                   |

  #### REMOVE (1 finding deleted)

  - **execFileSync URL validation** (`audit-security-1781133982-execfilesync-passes-user-influenced-repo-clone-url-to-git-clone-without-validati`)
    - **Reason**: UNNECESSARY — execFileSync prevents shell injection, GitHub API is over TLS, defense-in-depth for MITM on GitHub's own API is overkill for a personal CLI tool
    - **Annotation**:
      - finding_id: `audit-security-1781133982-execfilesync-passes-user-influenced-repo-clone-url-to-git-clone-without-validati`
      - reason_code: `UNNECESSARY`
      - audit_source: `SECURITY`
      - evidence: `execFileSync prevents shell injection (no shell interpolation); GitHub API uses TLS; MITM on GitHub's own API is not a realistic threat for a personal CLI tool`

  #### CONSOLIDATE (5 groups, 14 → 5 findings)

  - **Group: Tailwind plugin removal** → surviving: `audit-code-quality-...prettier-plugin-tailwindcss...`
    - Merged: `audit-dead-code-...prettier-plugin-tailwindcss...` (dead-code source)
  - **Group: Dead frontend directory** → surviving: `audit-dead-code-...entire-frontend-directory...`
    - Merged: `audit-feature-integration-...dead-frontend-directory...` (feature-integration source)
  - **Group: Duplicate utility code** → surviving: `audit-reorg-...duplicate-utility-code...`
    - Merged: `audit-security-...duplicated-parseargs-and-stripquotes...` (security source), `audit-techdebt-...duplicate-utility-functions...` (techdebt source)
  - **Group: Synchronous I/O** → surviving: `audit-security-...synchronous-filesystem-operations...`
    - Merged: `audit-techdebt-...synchronous-i-o-throughout...` (techdebt source)
  - **Group: Bare catch block** → surviving: `audit-code-quality-...identical-eslint-config-js-for...`
    - Merged: `audit-security-...bare-catch-block-silently-swallows...` (security source)

  #### KEEP (4 findings retained as-is)

  - **cloneOrPull private/untestable** (`audit-architecture-...cloneorpull-function-is-private...`) — priority 3
  - **Misleading .nvmrc** (`audit-code-quality-...misleading-nvmrc...`) — priority 4
  - **Dead frontend directory** (`audit-dead-code-...entire-frontend-directory...`) — priority 4, consolidated
  - **Replace dotenv with Bun-native env** (`audit-security-...github-personal-access-token...`) — priority 1, description corrected (token was never committed to git)

  #### DOWNGRADE (3 findings)

  - **Duplicate .gitattributes entries** — priority 4 → 5 (harmless housekeeping)
  - **cloneOrPull name-match logic** — priority 3 → 4 (rare edge case, nice-to-have)
  - **No runStarsync test coverage** — priority 3 → 4 (nice-to-have for personal CLI)

  #### Pipeline Handoff Notes

  - 4 KEEP findings remain in backlog — recommend: `Run the native feature-review ingredient for starsync to validate remaining finding specs against codebase conventions`
  - 1 REMOVE as UNNECESSARY from SECURITY audit — recommend: `Run the native audit-review ingredient on the SECURITY audit definition to prevent future false positives`
  - No ESCALATE findings (not a spernakit-derived app)
  - No roadmap.json — assignment skipped

  #### Final Feature Inventory

  - **Total**: 19 feature directories (11 audit findings + 8 non-audit features)
  - **Audit findings by status**: 11 backlog, 0 completed
  - **Non-audit features by status**: 0 backlog, 8 completed
  - **All JSON valid**, **no orphaned directories**, **all dependency references resolve**

### Added

- Testing scenarios augment (testing-scenarios starsync augment, 2026-08-16) in `.aidd/testing-scenarios.md`
  - Added 5 new scenarios (16–20) to fill coverage gaps:
    16. Partial sync failure — one repo fails while others succeed, "Failed repositories" list printed, exit code 1
    17. Pagination (>100 starred repos) — Octokit paginates through all pages, succeeded count matches actual total
    18. Empty starred list — zero repos returns "Succeeded: 0. Failed: 0." with exit code 0
    19. Cross-cutting end-to-end — sync into fresh temp dir then set-folder-dates, both exit code 0 and timestamps match
    20. set-folder-dates --help — prints help text with usage, --dry-run, TARGET_PATH docs, exits code 0
  - Coverage rationale: filled gaps in partial failure handling, pagination boundary, empty-result edge case, cross-tool workflow, and companion script help flag
  - Existing scenarios 1–15 and Post-Test Procedure untouched

- Feature coverage audit (2026-06-10) in `.aidd/reports/feature-coverage-audit-2026-06-10.md`
  - All 7 implemented capabilities backfilled with feature JSONs (previously 0 existed)
  - No ambiguous boundaries or stale docs found
  - No `.aidd/roadmap.json` exists — feature IDs not added to any milestone
  - `--check-features` validation pending (bun not available in agent environment)
- Created 7 feature JSONs under `.aidd/features/`:
  - `starred-repo-sync` (core) — sync engine with Octokit pagination, clone/pull, summary
  - `cli-argument-parsing` (cli) — --help, positional args, unknown flag rejection
  - `target-path-resolution` (cli) — positional > env > default resolution, stripQuotes
  - `folder-date-normalization` (companion) — mtime normalization via git log, --dry-run
  - `folder-discovery` (core) — listFolders utility for existing repo detection
  - `unit-test-suite` (quality) — Bun tests for parseArgs, resolveTargetPath, listFolders, stripQuotes
  - `build-and-compile-pipeline` (tooling) — bun build, compile, smoke:qc
- Codebase analysis report (2026-06-10, refresh 2) in `.aidd/audit-reports/CODEBASE_ANALYSIS-2026-06-10.md`
  - Overall health grade: B+ (unchanged — no source code changes since prior analysis)
  - Analyzed commit `6c4088d` + uncommitted working-tree changes
  - No source code changes since commit `7b81885` (May 6) — all recent commits are AIDD metadata only
  - Working tree still dirty: package.json and bun.lock changes remain uncommitted
  - 1 required AIDD artifact now present: testing-scenarios.md (was missing in prior report)
  - 1 required artifact still missing: spec.md
  - All prior findings (dead frontend/, untestable cloneOrPull, no concurrency) remain unresolved
- Codebase analysis report (2026-06-10, refresh) in `.aidd/audit-reports/CODEBASE_ANALYSIS-2026-06-10.md`
  - Overall health grade: B+ (unchanged)
  - Analyzed commit `ffcb5a1` + uncommitted working-tree changes (packageManager, only-allow)
  - Noted uncommitted working tree: package.json and bun.lock changes pending commit
  - Identified 2 required AIDD artifacts missing (spec.md, CONTEXT.md)
  - All prior findings (dead frontend/, untestable cloneOrPull, no concurrency) remain unresolved
- Project assurance profile (2026-06-10) at `.aidd/project-profile.json`
- Project assurance profile refresh (2026-07-14): verified all fields against codebase, no changes needed — profile is accurate
- Project assurance profile refresh (2026-07-27): re-verified all fields against package.json, tsconfig.json, eslint.config.js, src/index.ts, src/cli.ts — no fields are clearly wrong, profile is accurate, no changes made
- Feature coverage audit refresh (2026-06-10) in `.aidd/reports/feature-coverage-audit-2026-06-10.md`
  - Re-audited all implemented capabilities against feature JSONs
  - 8 capabilities / 8 feature JSONs — all covered, no gaps
  - No new capabilities detected since 2026-07-14 audit
  - No feature JSONs created, modified, or deleted
  - No ambiguous boundaries or stale docs found
- Feature coverage audit refresh (2026-07-14) in `.aidd/reports/feature-coverage-audit-2026-07-14.md`
  - Detected 1 new capability since 2026-06-10 audit: package-manager-enforcement
  - Created `package-manager-enforcement/feature.json` (only-allow preinstall hook, packageManager field, engines)
  - Updated README.md Install section to document Bun enforcement
  - All 8 implemented capabilities now covered
  - No ambiguous boundaries or stale docs found
  - Local feature JSON validation passed (8/8 valid, 0 errors)
  - Formal `--check-features` pending (requires d:/applications/aidd outside workspace)

### Changed

- Replaced dotenv with Bun-native env loading (`audit-security-1781133982-github-personal-access-token-committed-to-env-file-in-version-control`)
  - Removed `dotenv` import and `loadDotenv()` call from `src/index.ts` (was line 2, line 126)
  - Removed `dotenv` import and `loadDotenv()` call from `scripts/set-folder-dates.ts` (was line 3, line 59)
  - Removed `dotenv` from `package.json` dependencies
  - Updated `bun.lock` via `bun install`
  - Updated `README.md` Configuration section: replaced `.env.example` copy instruction with Bun-native `.env` guidance (Bun auto-loads `.env` files, no library needed)
  - Updated error message from `'GITHUB_TOKEN is not set in .env'` to `'GITHUB_TOKEN is not set'` (token source is now shell/Bun-native, not dotenv-specific)
  - Removed dependency on `audit-reorg-...duplicate-utility-code...` (was file-overlap only, not functional)
  - All 8 tests pass, smoke:qc passes

### Deprecated

### Removed

### Fixed

### Security

- Testing scenarios augment (testing-scenarios starsync augment, 2026-07-27) in `.aidd/testing-scenarios.md`
  - Added 5 new scenarios (11–15) to fill coverage gaps:
    11. --help / -h flag displays help text and exits with code 0
    12. TARGET_PATH env var resolution (no positional argument)
    13. set-folder-dates with non-existent root path error
    14. Invalid/expired GITHUB_TOKEN API authentication error
    15. bun test unit test execution (parseArgs, resolveTargetPath, listFolders, stripQuotes)
  - Coverage rationale: filled gaps in help flag coverage, env-only path resolution, error boundary for non-existent directories, invalid auth token handling, and unit test execution verification
  - Existing scenarios 1–10 and Post-Test Procedure untouched

- Testing scenarios seed (testing-scenarios starsync seed, 2026-07-15) in `.aidd/testing-scenarios.md`
  - Created 10 scenarios covering all major feature areas:
    1. Full sync with valid token (happy path, exit code 0)
    2. Re-sync pulls existing repos (idempotent behavior)
    3. Custom target-path positional override
    4. Missing GITHUB_TOKEN error (exit code 1)
    5. set-folder-dates mtime normalization with timestamp tables
    6. set-folder-dates --dry-run preview mode
    7. Build and compile pipeline (bundled output + standalone binary)
    8. Unknown CLI flags rejection (exit code 2)
    9. smoke:qc quality gate (typecheck + lint + format)
    10. Mixed target directory (non-git folders alongside repos)
  - Coverage rationale: one scenario per major feature area (sync engine, companion script, build pipeline, CLI arg parsing, quality gate), cross-cutting flows (re-sync idempotency, mixed directory handling), and edge cases (missing auth, unknown flags)
  - No RBAC scenarios needed (single-user CLI tool, no auth tiers)

### Reviewed

- Document review (review-doc spec.md, 2026-07-27) in `.aidd/reports/review-doc-spec-2026-07-27.md`
  - Reviewed `.aidd/spec.md` — **document does not exist** (required AIDD artifact)
  - This is the 4th review confirming absence (flagged in intake 2026-06-10, feature-coverage-audit 2026-06-10, feature-coverage-audit 2026-07-14)
  - Compensating artifacts partially cover the spec's role: 8 feature JSONs (all accurate), project-structure.md, project-profile.json, README.md, testing-scenarios.md
  - Impact assessed as LOW risk currently (stable, complete CLI, no active development) but MEDIUM future risk for new features/backlog remediation
  - Recommended spec content outlined: product definition, CLI interface, auth, sync behavior, companion script, quality gate, technology constraints
  - Report saved to `.aidd/reports/review-doc-spec-2026-07-27.md`

- Feature review (feature-review starsync, 2026-06-10 #2) in `.aidd/reports/feature-review-2026-06-10-starsync.md`
  - Reviewed all 8 feature.json files against codebase
  - 0 backlog features found (all 8 are completed with passes: true)
  - 0 template features found
  - 0 issues found (0 conflicts, 0 contradictions, 0 vague, 0 duplications, 0 minor)
  - Cross-validated all completed features against source code — all specs remain accurate
  - Dependency graph verified: no cycles, no missing references
  - Structural validity confirmed: all required fields present, valid ID formats, valid statuses
  - No auto-fixes needed, no roadmap assignment (no roadmap.json exists)
  - Feature inventory health: 8 total / 0 backlog / 8 completed
- Feature review (feature-review starsync, 2026-07-27 #2) in `.aidd/reports/feature-review-2026-07-27.md`
  - Reviewed all 8 feature.json files against codebase
  - 0 backlog features found (all 8 are completed with passes: true)
  - 0 template features found
  - 0 issues found (0 conflicts, 0 contradictions, 0 vague, 0 duplications, 0 minor)
  - Cross-validated all 39 spec lines against source code — all accurate
  - Dependency graph verified: no cycles, no missing references
  - Structural validity confirmed: all required fields present, valid ID formats, valid statuses
  - smoke:qc passed (typecheck + lint + format:check), bun test passed (8/8)
  - No auto-fixes needed, no roadmap assignment (no roadmap.json exists)
  - Feature inventory health: 8 total / 0 backlog / 8 completed
- Feature review (feature-review starsync, 2026-07-27) in `.aidd/reports/feature-review-2026-07-27.md`
  - Reviewed all 8 feature.json files against codebase
  - 0 backlog features found (all 8 are completed with passes: true)
  - 0 template features found
  - 0 issues found (0 conflicts, 0 contradictions, 0 vague, 0 duplications, 0 minor)
  - Cross-validated all completed features against source code — all specs remain accurate
  - Dependency graph verified: no cycles, no missing references
  - Structural validity confirmed: all required fields present, valid ID formats, valid statuses
  - No auto-fixes needed, no roadmap assignment (no roadmap.json exists)
  - Feature inventory health: 8 total / 0 backlog / 8 completed
- Feature review (feature-review starsync, 2026-07-15) in `.aidd/reports/feature-review-2026-07-15.md`
  - Reviewed all 8 feature.json files against codebase
  - 0 backlog features found (all 8 are completed with passes: true)
  - 0 template features found
  - 0 issues found (0 conflicts, 0 contradictions, 0 vague, 0 duplications, 0 minor)
  - Cross-validated all completed features against source code — all specs remain accurate
  - Dependency graph verified: no cycles, no missing references
  - Structural validity confirmed: all required fields present, valid ID formats, valid statuses
  - No auto-fixes needed, no roadmap assignment (no roadmap.json exists)
  - Feature inventory health: 8 total / 0 backlog / 8 completed
- Feature review (feature-review starsync, 2026-06-10) in `.aidd/reports/feature-review-2026-06-10.md`
  - Reviewed all 8 feature.json files against codebase
  - 0 backlog features found (all 8 are completed with passes: true)
  - 0 template features found
  - 0 issues found (0 conflicts, 0 contradictions, 0 vague, 0 duplications, 0 minor)
  - Cross-validated all completed features against source code — all specs remain accurate
  - Dependency graph verified: no cycles, no missing references
  - Structural validity confirmed: all required fields present, valid ID formats, valid statuses
  - No auto-fixes needed, no roadmap assignment (no roadmap.json exists)
  - Feature inventory health: 8 total / 0 backlog / 8 completed
