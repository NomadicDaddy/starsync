# Changelog

All notable changes to this project will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `--help` / `-h` flag for both `index.ts` and `scripts/set-folder-dates.ts`. Unknown arguments now exit 2 with usage text.
- `index.ts` now accepts a positional target-path argument that overrides `TARGET_PATH`.
- Per-repo success/failure summary at end of sync run.

### Changed

- All `git` subprocesses migrated from `execSync` (string interpolation) to `execFileSync` (argv array). Eliminates shell metacharacter handling in repo names and clone URLs.
- Default target path is now consistently `<repo>/starred_repos` for both scripts (previously `index.ts` used `process.cwd()/starred_repos`, `set-folder-dates.ts` used `<repo>/starred_repos`).
- `TARGET_PATH` env-var parsing is unified across both scripts: trim + strip surrounding quotes.
- `.env` file is now resolved relative to the repo root (not cwd), so both scripts find it regardless of the directory the command is invoked from.
- Error messages use the consistent `(error as Error).message` form.
- `formatTable` is properly typed with generics; no more `any[]`.

### Fixed

- `index.ts` no longer exits 0 when the GitHub fetch fails. Both fetch failures and per-repo clone/pull failures now propagate to a non-zero exit code so cron jobs can detect failures.
- `set-folder-dates.ts` accepts only the canonical `--dry-run` spelling; the `--dryrun` and `-dryrun` aliases were removed.

### Security

- Subprocess argv arrays prevent shell injection via folder names returned from `fs.readdirSync` (a folder named `; rm -rf ~ #` could previously have been interpreted by the shell in `set-folder-dates.ts`).

## [1.0.0]

- Initial commit.
