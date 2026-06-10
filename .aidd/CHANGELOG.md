# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Codebase analysis report (2026-06-10, refresh) in `.aidd/audit-reports/CODEBASE_ANALYSIS-2026-06-10.md`
  - Overall health grade: B+ (unchanged)
  - Analyzed commit `ffcb5a1` + uncommitted working-tree changes (packageManager, only-allow)
  - Noted uncommitted working tree: package.json and bun.lock changes pending commit
  - Identified 2 required AIDD artifacts missing (spec.md, CONTEXT.md)
  - All prior findings (dead frontend/, untestable cloneOrPull, no concurrency) remain unresolved
- Project assurance profile (2026-06-10) at `.aidd/project-profile.json`
- Project assurance profile refresh (2026-07-14): verified all fields against codebase, no changes needed — profile is accurate

### Changed

### Deprecated

### Removed

### Fixed

### Security
