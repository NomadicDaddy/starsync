# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
- Codebase analysis report (2026-06-10, refresh) in `.aidd/audit-reports/CODEBASE_ANALYSIS-2026-06-10.md`
  - Overall health grade: B+ (unchanged)
  - Analyzed commit `ffcb5a1` + uncommitted working-tree changes (packageManager, only-allow)
  - Noted uncommitted working tree: package.json and bun.lock changes pending commit
  - Identified 2 required AIDD artifacts missing (spec.md, CONTEXT.md)
  - All prior findings (dead frontend/, untestable cloneOrPull, no concurrency) remain unresolved
- Project assurance profile (2026-06-10) at `.aidd/project-profile.json`
- Project assurance profile refresh (2026-07-14): verified all fields against codebase, no changes needed — profile is accurate
- Feature coverage audit refresh (2026-07-14) in `.aidd/reports/feature-coverage-audit-2026-07-14.md`
  - Detected 1 new capability since 2026-06-10 audit: package-manager-enforcement
  - Created `package-manager-enforcement/feature.json` (only-allow preinstall hook, packageManager field, engines)
  - Updated README.md Install section to document Bun enforcement
  - All 8 implemented capabilities now covered
  - No ambiguous boundaries or stale docs found
  - Local feature JSON validation passed (8/8 valid, 0 errors)
  - Formal `--check-features` pending (requires d:/applications/aidd outside workspace)

### Changed

### Deprecated

### Removed

### Fixed

### Security

### Reviewed

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
