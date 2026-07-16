# Changelog

All notable changes to this project will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Added `--json` to every subcommand with a stable schema-versioned report, separate checkout
  lifecycle and run outcome fields, severity-classified findings, predictable exit codes, and
  partial results after a first interruption.

## [1.1.1] - 2026-07-14

### Fixed

- Remote checks now accept cosmetic URL differences such as owner casing, a missing `.git`
  suffix, or trailing slashes. Repositories with genuinely different owners or names are still
  skipped.
- Existing clones are now found on case-insensitive filesystems even when the folder and GitHub
  repository use different capitalization. This prevents StarSync from trying to clone over the
  existing directory.

## [1.1.0] - 2026-06-11

### Added

- `--help` / `-h` flag for both `index.ts` and `scripts/set-folder-dates.ts`. Unknown arguments now exit 2 with usage text.
- `index.ts` now accepts a positional target-path argument that overrides `TARGET_PATH`.
- Per-repo success/failure summary at end of sync run.

### Changed

- All `git` subprocesses migrated from `execSync` (string interpolation) to `execFileSync` (argv array). Eliminates shell metacharacter handling in repo names and clone URLs.
- Default target path is now consistently `<repo>/starred_repos` for both scripts (previously `index.ts` used `process.cwd()/starred_repos`, `set-folder-dates.ts` used `<repo>/starred_repos`).
- `TARGET_PATH` env-var parsing is unified across both scripts: trim + strip surrounding quotes.
- `GITHUB_TOKEN` is now loaded via Bun's native `.env` support; the `dotenv` dependency was removed entirely. The missing-token error message is now `GITHUB_TOKEN is not set`.
- Error messages use the consistent `(error as Error).message` form.
- `formatTable` is properly typed with generics; no more `any[]`.
- `cloneOrPull` now verifies remote origin URL before pulling — prevents misidentifying repos with identical names from different owners.

### Fixed

- `index.ts` no longer exits 0 when the GitHub fetch fails. Both fetch failures and per-repo clone/pull failures now propagate to a non-zero exit code so cron jobs can detect failures.
- `set-folder-dates.ts` accepts only the canonical `--dry-run` spelling; the `--dryrun` and `-dryrun` aliases were removed.
- `set-folder-dates.ts` no longer silently skips a folder when `git log` or `fs.utimesSync` fails — it now prints a warning with the folder name and the underlying error before marking it skipped.
- Deduplicated `.gitattributes` so each file pattern appears exactly once, organized into text and binary sections.

### Removed

- Unused `prettier-plugin-tailwindcss` dev dependency (this CLI tool has no frontend or Tailwind usage).

### Security

- Subprocess argv arrays prevent shell injection via folder names returned from `fs.readdirSync` (a folder named `; rm -rf ~ #` could previously have been interpreted by the shell in `set-folder-dates.ts`).

## [1.0.0]

- Initial commit.
