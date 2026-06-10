# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Codebase analysis report (2026-06-10) in `.aidd/audit-reports/CODEBASE_ANALYSIS-2026-06-10.md`
  - Overall health grade: B+
  - Top issues: dead frontend/ directory, untestable core sync logic, sequential repo processing
  - Top opportunities: parallel clone/pull, incremental sync, shared utility extraction
  - Full findings across architecture, type safety, performance, security, testing, and dependencies
- Project assurance profile (2026-06-10) at `.aidd/project-profile.json`
  - Inferred from codebase analysis, source tree, package.json, and project-structure.md
  - Covers: stack, deployment, auth, data sensitivity, criticality, external integrations, validation commands

### Changed

### Deprecated

### Removed

### Fixed

### Security
