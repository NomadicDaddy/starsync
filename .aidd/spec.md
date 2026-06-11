# StarSync — Application Specification

## Product Definition

**Name:** starsync
**Type:** CLI tool (Bun/TypeScript)
**Purpose:** Automatically synchronizes all starred GitHub repositories to the local filesystem. New repos are cloned; existing repos are pulled to the latest commit. A companion script normalizes folder timestamps to match each repo's latest commit date.

**Audience:** Individual developers who want a local mirror of their GitHub starred repos.

## CLI Interface

### Main Command (`bun run sync` / `bun src/cli.ts`)

```
starsync [options] [target-path]
```

| Argument / Flag   | Behavior                                                      |
| ----------------- | ------------------------------------------------------------- |
| `[target-path]`   | Overrides `TARGET_PATH` env var and default `starred_repos/`  |
| `--help`, `-h`    | Prints help text, exits code 0                                |
| (unknown flag)    | Prints error + help text, exits code 2                        |

**Exit codes:** 0 = success, 1 = runtime error (auth failure, clone/pull failure), 2 = usage error

### Companion Script (`bun run set-folder-dates` / `bun scripts/set-folder-dates.ts`)

```
set-folder-dates [options] [target-path]
```

| Argument / Flag   | Behavior                                                      |
| ----------------- | ------------------------------------------------------------- |
| `[target-path]`   | Overrides `TARGET_PATH` env var and default `starred_repos/`  |
| `--dry-run`       | Preview changes without modifying timestamps                  |
| `--help`, `-h`    | Prints help text, exits code 0                                |
| (unknown flag)    | Prints error + help text, exits code 2                        |

## Authentication

- **Mechanism:** GitHub Personal Access Token via `GITHUB_TOKEN` environment variable
- **Loading:** Bun auto-loads `.env` files (no library required)
- **Scopes:** `repo` + `read:user`
- **Error behavior:** Exits code 1 with message "GITHUB_TOKEN is not set" when missing

## Sync Behavior

1. Parse CLI arguments (help, target path, reject unknown flags)
2. Validate `GITHUB_TOKEN` is present (exit code 1 if missing)
3. Resolve target directory: positional arg > `TARGET_PATH` env > `<repo>/starred_repos`
4. Create target directory if it doesn't exist
5. List existing folders in target directory
6. Fetch all starred repos via GitHub REST API (`activity.listReposStarredByAuthenticatedUser`), paginated at 100/page
7. For each repo: if folder exists with `.git/` subdirectory → `git pull`; otherwise → `git clone`
8. Print summary: "Succeeded: N. Failed: N."
9. If any failures: list them under "Failed repositories" and exit code 1

### Path Resolution Priority

1. Positional CLI argument (highest)
2. `TARGET_PATH` environment variable (quote-stripped)
3. `<repo_root>/starred_repos` (default)

### Folder Matching Logic

- Existing folders are matched by name (case-sensitive) AND presence of `.git/` subdirectory
- If a folder exists but lacks `.git/`, it is treated as a new clone target
- **Known limitation:** Two repos with identical names from different owners will collide (name-only matching, no remote URL verification)

## Companion Script Behavior (set-folder-dates)

1. Parse CLI arguments (help, dry-run, target path)
2. Resolve target directory (same priority as sync)
3. Verify target directory exists (exit code 1 if missing)
4. For each subdirectory:
   - Skip non-directories
   - Skip non-git directories (status: `skipped:not-git`)
   - Get latest commit date via `git log -1 --format=%cI`
   - Update folder mtime to match commit date (or show preview in dry-run mode)
   - Skip if git log fails (status: `skipped:no-commit`)
5. Print summary: updated/would-update count, skipped count
6. Display oldest/newest timestamp tables (top 10 each)
7. Display skipped folders table

## Data Model

- **ParsedArgs:** `{ help: boolean, targetPath: string | null }`
- **Repository:** `{ name: string, clone_url: string }` (GitHub API subset)
- **SyncFailure:** `{ name: string, verb: 'clone' | 'pull', message: string }`
- **SyncResult:** Discriminated union — `{ ok: true, failure: null } | { ok: false, failure: SyncFailure }`

## Quality Gate

- **`bun run smoke:qc`** = typecheck + lint + format:check (must pass before every commit)
- **`bun test`** — unit tests for `parseArgs`, `resolveTargetPath`, `listFolders`, `stripQuotes`
- **`bun run build`** — bundled output in `dist/`
- **`bun run compile`** — standalone binary at `dist/starsync`

## Technology Constraints

- **Runtime:** Bun >= 1.3.14 (no Node.js runtime usage)
- **Language:** TypeScript (strict mode, ES2022, ESM only)
- **No framework** — pure CLI tool
- **No database** — filesystem-only
- **External APIs:** GitHub REST API via `@octokit/rest`, local git via `execFileSync`
- **Package manager enforcement:** `only-allow bun` preinstall hook
- **Formatting:** Prettier (tabs, 100 chars, single quotes)
- **Linting:** ESLint with typescript-eslint, perfectionist, unused-imports
- **No Tailwind, no CSS, no frontend** — despite a dead `frontend/` directory

## File Layout

```
src/
  cli.ts        # CLI entrypoint — calls runStarsync, handles top-level errors
  index.ts      # Core logic: parseArgs, cloneOrPull, runStarsync (exported),
                # re-exports stripQuotes and resolveTargetPath from lib/
  lib/
    cli-utils.ts  # Shared CLI utilities: stripQuotes, resolveTargetPath
scripts/
  set-folder-dates.ts  # Companion: updates folder mtimes from git log
test/
  index.test.ts        # Unit tests for exported functions
```

## Known Limitations

1. `cloneOrPull` is private (not exported) — cannot be unit-tested without refactoring
2. `cloneOrPull` uses name-only matching — no remote URL verification for existing directories
3. `frontend/` directory is dead (only orphaned eslint config) — candidate for removal
4. `.gitattributes` has duplicate entries
