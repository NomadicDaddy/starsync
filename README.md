# starsync

**SAVE YOUR STARRED REPOS BEFORE THEY DISAPPEAR!**

Clone or pull every starred GitHub repository to your local machine. Subsequent runs pull each existing repo to the latest commit; new stars are cloned.

Bun + TypeScript CLI plus a companion script for normalizing folder timestamps.

## Install

Requires [Bun](https://bun.sh) >= 1.3.14. Node.js is not a supported runtime. StarSync
supports Windows, macOS, and Linux where Bun and Git are available.

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
| `TARGET_PATH`  | yes*     | Managed archive path; omit only when passing it directly. |

A positional argument on the command line overrides `TARGET_PATH`.

## Usage

StarSync provides six explicit subcommands:

```sh
bun src/cli.ts sync [options] [target-path]
bun src/cli.ts verify [options] [target-path]
bun src/cli.ts migrate [options] [target-path]
bun src/cli.ts dates [options] [target-path]
bun src/cli.ts init [options] [target-path]
bun src/cli.ts unlock [options] [target-path]
```

`init`, `sync`, `verify`, `dates`, and the read-only `migrate` preview are available now. `unlock`
is recognized but exits with code 1 until its behavior ships. `migrate --apply` remains reserved
for its migration feature. Every command requires either `[target-path]` or `TARGET_PATH`; missing
both is a usage error with exit code 2. Bare `starsync [target-path]` remains a deprecated alias for
`sync` during the transition.

`init` requires an existing empty directory and `GITHUB_TOKEN`. It authenticates the GitHub
account, then writes `.starsync/config.json` with only archive format 2 and
`owner: { id, login }`. Modifying commands reject uninitialized, older, newer, or invalid managed
archives. `sync` also rejects credentials for an account whose stable ID does not match the
archive owner; a renamed login with the same ID remains the same owner.

A configless, non-empty directory containing GitHub.com checkouts is recognized as a legacy
archive. `sync` and `dates` refuse to modify legacy archives. The
read-only `migrate` preview and `verify` are available now. The migration preview resolves each
checkout's stable GitHub repository ID and current slug, proposes the canonical
`repository--owner` folder, and reports dirty or unverifiable state, name collisions, invalid or
credential-bearing origins, duplicate identities, and pending renames without writing to the
archive.

`verify` is fully local and does not require `GITHUB_TOKEN` or network access. It runs Git object
integrity checks, validates origins and checkout state, detects duplicate identities and pending
renames, and verifies managed archive owner binding. Managed archive config records
`owner: { id, login }`; checkout-local Git config records `starsync.repository-id` and
`starsync.repository-slug`. Missing identity metadata is an expected warning for legacy archives
and an error for managed archives. Verification never repairs Git data, writes metadata, renames
folders, or updates timestamps.

Common options:

| Option            | Description                                                      |
| ----------------- | ---------------------------------------------------------------- |
| `--help`, `-h`    | Show command-specific usage                                      |
| `--json`          | Emit one schema-versioned result document on stdout              |
| `--dry-run`       | Preview `sync` or `dates` without changing the archive           |
| `--concurrency=N` | Process 1-8 repositories concurrently during `sync` (default: 4) |

The legacy folder-date command remains available as a deprecated alias:

```sh
bun run set-folder-dates -- [--dry-run] [target-path]
```

### Structured reporting

Every subcommand accepts `--json`. JSON mode writes exactly one result document to stdout and
sends progress, warnings, and errors to stderr. Reports use integer `schemaVersion: 1` and keep
these concepts independent:

- checkout lifecycle: `active`, `retained`, or `blocked`;
- pending rename: a separate boolean warning state;
- current-run outcome: `added`, `updated`, `current`, `skipped`, or `failed`;
- findings: `info`, `warning`, or `error`.

Schema version 1 may gain additive fields. Removing a field or changing its meaning requires a new
schema version. Reports are emitted only to the process streams; routine run reports are not saved
inside the archive.

All subcommands use the same exit contract: 0 when there are no errors, 1 for an operational
failure or blocked request, 2 for invalid usage, and 130 after user interruption. On the first
interrupt, StarSync stops scheduling new work, lets in-flight Git operations finish, and emits the
partial result.

### Programmatic API

StarSync is also an importable Bun library. The supported operations accept explicit options and
return the same `CommandReport` shape emitted by CLI JSON mode. They do not read command-line
arguments, write to process streams, or exit the process. Progress is available only through the
optional callback, and cancellation uses a standard `AbortSignal`.

```ts
import { syncArchive } from 'starsync';

const controller = new AbortController();
const report = await syncArchive({
	concurrency: 4,
	onProgress: (message) => console.log(message),
	signal: controller.signal,
	targetPath: 'D:/archives/stars',
	token: Bun.env.GITHUB_TOKEN ?? '',
});

if (report.exitCode !== 0) {
	// Inspect report.findings and report.checkouts without parsing subprocess output.
}
```

The public entry point exports:

| Operation               | Purpose                                     |
| ----------------------- | ------------------------------------------- |
| `syncArchive`           | Synchronize or preview an archive refresh   |
| `verifyArchive`         | Run read-only local archive verification    |
| `migrateArchive`        | Preview archive migration                   |
| `normalizeArchiveDates` | Preview or normalize checkout folder dates  |
| `initArchive`           | Initialize an archive when v2 support ships |

`initArchive` and `migrateArchive({ apply: true })` currently return a structured
`command-unavailable` report because those mutation features have not shipped. The deprecated
low-level exports remain during the 1.x transition for compatibility; consumers should migrate
from `runStarsync`, argument parsing, checkout discovery, and direct clone/pull helpers to these
command-level operations before 2.0.

## Scripts

| Script                     | What it runs                                                      |
| -------------------------- | ----------------------------------------------------------------- |
| `bun run sync`             | `bun ./src/cli.ts`                                                |
| `bun start`                | `bun src/cli.ts`                                                  |
| `bun run set-folder-dates` | `bun ./scripts/set-folder-dates.ts`                               |
| `bun run build`            | `bun build ./src/cli.ts --target=bun`                             |
| `bun run compile`          | standalone binary in `dist/`                                      |
| `bun run typecheck`        | `tsc --noEmit`                                                    |
| `bun run lint`             | `eslint "src/**/*.ts" "scripts/**/*.ts" "test/**/*.ts"`           |
| `bun run smoke:qc`         | typecheck, lint, format check, test                               |
| `bun run format`           | `prettier --write "src/**/*.ts" "scripts/**/*.ts" "test/**/*.ts"` |
| `bun run format:check`     | `prettier --check "src/**/*.ts" "scripts/**/*.ts" "test/**/*.ts"` |

## Scheduling

Schedule the sync via Windows Task Scheduler, cron, launchd, or any other periodic runner. The non-zero exit code on failure lets the scheduler surface problems instead of silently succeeding.

## License

MIT
