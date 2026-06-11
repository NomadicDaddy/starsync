# Assertions — StarSync

## Behavioral Invariants

### CLI Behavior

1. **Exit code 0** — sync completes with zero failures
2. **Exit code 1** — GITHUB_TOKEN missing, GitHub API error, or any clone/pull failure
3. **Exit code 2** — unknown CLI argument or repeated positional argument
4. **`--help` / `-h`** always prints help text to stdout and exits code 0
5. **No unknown flags** are silently ignored — all produce an error

### Sync Engine

6. **Pagination** — Octokit paginates through all starred repos at 100/page; no repo is skipped
7. **Clone-or-pull decision** — if folder exists with `.git/` subdirectory → pull; otherwise → clone
8. **Partial failure resilience** — one repo failure does not abort the sync; all repos are processed
9. **Summary always printed** — "Succeeded: N. Failed: N." appears after every run
10. **Failure details** — when failures exist, each is listed with repo name, verb (clone/pull), and error message

### Path Resolution

11. **Priority order** — positional argument > TARGET_PATH env var > `<repo>/starred_repos`
12. **Target directory creation** — `mkdirSync({ recursive: true })` ensures the target exists before sync
13. **Quote stripping** — env var values are stripped of surrounding quotes/whitespace

### Authentication

14. **Token required** — `GITHUB_TOKEN` must be set; missing token exits code 1 with descriptive message
15. **Bun-native loading** — `.env` files loaded by Bun's built-in mechanism (no dotenv library)
16. **Token never committed** — `.env` is in `.gitignore` and has never been in git history

### Companion Script (set-folder-dates)

17. **Non-destructive by default** — `--dry-run` previews changes without modifying timestamps
18. **Non-git folders skipped** — directories without `.git/` are reported as `skipped:not-git`
19. **Timestamp tables** — oldest/newest folder timestamps displayed (top 10 each) when changes exist
20. **Root path validation** — exits code 1 if target directory does not exist

### Data Invariants

21. **No database** — all state is filesystem-only (no DB, no config files, no persisted metadata)
22. **Git operations use execFileSync** — no shell interpolation, no injection risk
23. **No concurrency** — sequential clone/pull operations, one repo at a time

### Quality

24. **`bun run smoke:qc`** must pass before every commit (typecheck + lint + format:check)
25. **`bun test`** must pass — covers `parseArgs`, `resolveTargetPath`, `listFolders`, `stripQuotes`
26. **Bun-only package manager** — `only-allow bun` preinstall hook rejects npm/yarn/pnpm
