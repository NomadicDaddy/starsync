# starsync

**SAVE YOUR STARRED REPOS BEFORE THEY DISAPPEAR!**

Clone or pull every starred GitHub repository to your local machine. Subsequent runs pull each existing repo to the latest commit; new stars are cloned.

Bun + TypeScript CLI plus a companion script for normalizing folder timestamps.

## Install

Requires [Bun](https://bun.sh) >= 1.3.14.

```sh
bun install
```

The `preinstall` hook enforces Bun as the package manager — `npm install`, `yarn install`, and `pnpm install` will be rejected.

## Authentication

StarSync separates API authentication from Git transport authentication:

- **GitHub API** (listing starred repos): uses `GITHUB_TOKEN` via Octokit. Required for `sync`, `init`, and `migrate`.
- **Git clone/pull** (transport): uses your system Git credentials — Git Credential Manager or SSH keys. StarSync never embeds the API token in Git operations.

When Git credentials are missing or invalid, StarSync reports a clear failure with guidance to configure Git Credential Manager or SSH keys. StarSync also prevents Git from prompting interactively (`GIT_TERMINAL_PROMPT=0`, `core.askPass=`).

### Secret Safety

- API tokens and embedded Git credentials are never placed in command arguments, logs, or archive metadata.
- Remote URLs in error messages are sanitized — embedded credentials are stripped before any output.
- Git error messages are scanned for token patterns (`ghp_…`, `github_pat_…`) and redacted.
- Repository origins are validated as GitHub.com — GitHub Enterprise Server and other hosts are rejected.

### Configuration

Create a `.env` file in the project root (Bun auto-loads it) or set the variable in your shell:

```sh
# Option A: .env file (Bun loads it automatically)
GITHUB_TOKEN=ghp_your_token_here

# Option B: inline environment variable
GITHUB_TOKEN=ghp_your_token_here bun run sync
```

| Variable       | Required | Description                                               |
| -------------- | -------- | --------------------------------------------------------- |
| `GITHUB_TOKEN` | yes      | Personal access token with `repo` and `read:user` scopes. |
| `TARGET_PATH`  | no       | Where to sync repos. Defaults to `<repo>/starred_repos`.  |

A positional argument on the command line overrides `TARGET_PATH`.

## Usage

Sync all starred repos:

```sh
bun run sync
# or
bun src/cli.ts [target-path]
```

Update each top-level repo folder's mtime to match its latest commit:

```sh
bun run set-folder-dates -- [--dry-run] [target-path]
```

| Option         | Description                                             |
| -------------- | ------------------------------------------------------- |
| `--help`, `-h` | Show usage                                              |
| `--dry-run`    | (set-folder-dates) preview without modifying timestamps |

Both commands exit with code 2 on unknown arguments and code 1 on runtime errors (including any clone/pull failures during sync).

## Scripts

| Script                     | What it runs                        |
| -------------------------- | ----------------------------------- |
| `bun run sync`             | `bun ./src/cli.ts`                  |
| `bun start`                | `bun src/cli.ts`                    |
| `bun run set-folder-dates` | `bun ./scripts/set-folder-dates.ts` |
| `bun run build`            | `bun build ./src/cli.ts --target=bun` |
| `bun run compile`          | standalone binary in `dist/`        |
| `bun run typecheck`        | `tsc --noEmit`                      |
| `bun run lint`             | `eslint "src/**/*.ts" "scripts/**/*.ts" "test/**/*.ts"` |
| `bun run smoke:qc`         | typecheck, lint, format check, test |
| `bun run format`           | `prettier --write "src/**/*.ts" "scripts/**/*.ts" "test/**/*.ts"` |
| `bun run format:check`     | `prettier --check "src/**/*.ts" "scripts/**/*.ts" "test/**/*.ts"` |

## Scheduling

Schedule the sync via Windows Task Scheduler, cron, launchd, or any other periodic runner. The non-zero exit code on failure lets the scheduler surface problems instead of silently succeeding.

## License

MIT
