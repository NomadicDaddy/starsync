# starsync

**SAVE YOUR STARRED REPOS BEFORE THEY DISAPPEAR!**

Preserve every starred GitHub repository in a managed local archive. StarSync matches checkouts by
stable GitHub repository identity, refreshes existing history, and adds new stars under canonical
`repository--owner` folders.

Bun + TypeScript CLI and importable library for managed-archive operations.

## Install

Requires [Bun](https://bun.sh) >= 1.3.14. Node.js is not a supported runtime. StarSync
supports Windows, macOS, and Linux where Bun and Git are available.

```sh
bun install
```

The `preinstall` hook runs the dependency-free `scripts/require-bun.ts` guard. It rejects npm,
yarn, and pnpm before they install dependencies.

## Authentication

StarSync separates API authentication from Git transport authentication:

- **GitHub API** (listing starred repos): uses `GITHUB_TOKEN` via Octokit. Required for `sync`, `init`, and `migrate`.
- **Git clone/fetch** (transport): uses your system Git credentials — Git Credential Manager or SSH
  keys. StarSync never embeds the API token in Git operations.

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

# Option B: inline environment variable with an explicit archive
GITHUB_TOKEN=ghp_your_token_here bun src/cli.ts sync D:/archives/stars
```

| Variable       | Required | Description                                               |
| -------------- | -------- | --------------------------------------------------------- |
| `GITHUB_TOKEN` | yes      | Personal access token with `repo` and `read:user` scopes. |
| `TARGET_PATH`  | yes*     | Managed archive path; omit only when passing it directly. |

A positional argument on the command line overrides `TARGET_PATH`.

## Usage

StarSync provides six explicit subcommands:

```sh
bun src/cli.ts init [options] [target-path]
bun src/cli.ts sync [options] [target-path]
bun src/cli.ts verify [options] [target-path]
bun src/cli.ts migrate [options] [target-path]
bun src/cli.ts dates [options] [target-path]
bun src/cli.ts unlock [options] [target-path]
```

Every command requires either `[target-path]` or `TARGET_PATH`; missing both is a usage error with
exit code 2. All six commands are available, including read-only `migrate` preview and explicit
`migrate --apply`. Bare `starsync [target-path]` remains a deprecated 1.x compatibility alias;
new invocations should use `starsync sync [target-path]`.

`init` requires an existing empty directory and `GITHUB_TOKEN`. It authenticates the GitHub
account, then writes `.starsync/config.json` with only archive format 2 and
`owner: { id, login }`. Modifying commands reject uninitialized, older, newer, or invalid managed
archives. `sync` also rejects credentials for an account whose stable ID does not match the
archive owner; a renamed login with the same ID remains the same owner.

Every archive operation except lock recovery holds `.starsync/operation-lock.json` while it
inspects or changes the archive. The lock identifies the command, hostname, process ID, and start
time. StarSync automatically reclaims it only when the same-host process is confirmed dead. Remote
or uncertain ownership requires `starsync unlock --force [target-path]`; even forced unlock
refuses to remove a lock owned by a confirmed live same-host process.

A configless, non-empty directory containing GitHub.com checkouts is recognized as a legacy
archive. `sync` and `dates` refuse to modify legacy archives until migration completes. The
read-only `migrate` preview resolves each
checkout's stable GitHub repository ID and current slug, proposes the canonical
`repository--owner` folder, and reports dirty or unverifiable state, name collisions, invalid or
credential-bearing origins, duplicate identities, and pending renames without writing to the
archive.

`migrate --apply` records the ID and current slug in checkout-local Git configuration before
renaming a safe checkout. Successful checkout changes remain in place if another checkout fails.
The temporary `.starsync/migration-state.json` records only the authenticated archive owner needed
to resume, and is removed after all identities are recorded and the archive config reaches format 2. Dirty or unverifiable checkouts are adopted without changing their work; their identity is
recorded, their folder stays in place, and they remain blocked with a pending rename for a later
explicit migration.

Normal synchronization uses repository IDs rather than slugs or folder labels. New repositories
use `repository--owner`, but are first cloned into a unique StarSync-owned sibling staging
directory. StarSync validates the GitHub.com origin, Git objects, archive owner, and checkout
identity there before atomically publishing the canonical folder. Failed attempts clean up only
their owned staging directory, while occupied destinations remain untouched. A rename or ownership
transfer keeps using the existing checkout and reports a pending rename until migration is
explicitly applied. Duplicate identities and occupied canonical folders are errors and are never
published or renamed over. After each successful add or refresh, StarSync aligns the checkout
folder timestamp with its Archive Date.

`dates` is fully local and does not require `GITHUB_TOKEN` or network access. It recognizes managed
checkouts by their stable local identity, calculates each Archive Date from the newest committer
time reachable across all local Git references, and repairs folder timestamps. Use `--dry-run` to
preview the same repairs without changing the archive.

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
| `--apply`         | Apply `migrate` identity backfill and safe canonical renames     |

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

| Operation               | Purpose                                    |
| ----------------------- | ------------------------------------------ |
| `syncArchive`           | Synchronize or preview an archive refresh  |
| `verifyArchive`         | Run read-only local archive verification   |
| `migrateArchive`        | Preview or apply archive migration         |
| `normalizeArchiveDates` | Preview or normalize checkout folder dates |
| `initArchive`           | Initialize an empty managed archive        |
| `unlockArchive`         | Inspect or conservatively remove its lock  |

Pass `apply: true` to `migrateArchive` to apply the resumable migration; omit it for a read-only
preview. Deprecated low-level exports remain during the 1.x transition for compatibility. New
consumers should use the command-level archive operations.

## Release validation

The 2.0 release requires three independent evidence sets:

1. The active `Release Validation` GitHub Actions matrix runs on `windows-latest`,
   `macos-latest`, and `ubuntu-latest` with Bun 1.3.14. Each runner installs from `bun.lock`, runs
   `smoke:qc`, bundles the CLI, and compiles that platform's executable with `GITHUB_TOKEN` and
   `TARGET_PATH` unset.
2. The final 1.x build must produce a complete `migrate --json` preview of the live
   289-checkout archive, with every exception classified and reviewed. The 1.2 baseline recorded
   273 pending renames, 8 adopted-but-blocked checkouts, and 8 failed checkouts; preserve the
   report outside the archive as release evidence and rerun it if the archive changes before 2.0.
3. The representative copied-archive journey must pass migration, verification, synchronization,
   and Archive Date normalization. `smoke:qc` runs an offline real-Git copy fixture for this gate.
   A release candidate must also pass the explicitly enabled live smoke against a caller-created
   managed-archive copy under the operating system's temporary directory.

The live smoke is never part of routine tests. It performs only verification, a synchronization
dry run, and an Archive Date dry run. It refuses to start unless `STARSYNC_LIVE_SMOKE=1`,
`GITHUB_TOKEN`, and one positional temporary target are supplied, and it rejects the configured
`TARGET_PATH`:

```sh
# Set STARSYNC_LIVE_SMOKE=1 and GITHUB_TOKEN in the current shell first.
bun run smoke:live -- <temporary-managed-archive>
```

Do not release 2.0 from a matrix-only result: the reviewed live migration preview and the
representative-copy gate are separate required evidence.

## Scripts

| Script                    | What it runs                                                      |
| ------------------------- | ----------------------------------------------------------------- |
| `bun run sync`            | `bun ./src/cli.ts`                                                |
| `bun start`               | `bun src/cli.ts`                                                  |
| `bun run build`           | `bun build ./src/cli.ts --target=bun`                             |
| `bun run check:max-lines` | production file and extracted-function source-shape limits        |
| `bun run compile`         | standalone binary in `dist/`                                      |
| `bun run typecheck`       | `tsc --noEmit`                                                    |
| `bun run lint`            | `eslint "src/**/*.ts" "scripts/**/*.ts" "test/**/*.ts"`           |
| `bun run smoke:live`      | opt-in read-only smoke against an explicit temporary archive copy |
| `bun run smoke:qc`        | source shape, typecheck, lint, format check, test                  |
| `bun run format`          | `prettier --write "src/**/*.ts" "scripts/**/*.ts" "test/**/*.ts"` |
| `bun run format:check`    | `prettier --check "src/**/*.ts" "scripts/**/*.ts" "test/**/*.ts"` |

## Scheduling

Schedule the sync via Windows Task Scheduler, cron, launchd, or any other periodic runner. The non-zero exit code on failure lets the scheduler surface problems instead of silently succeeding.

## License

MIT
