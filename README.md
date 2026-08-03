# starsync

**SAVE YOUR STARRED REPOS BEFORE THEY DISAPPEAR!**

StarSync preserves every repository starred by one GitHub account in a managed local archive. It
matches checkouts by stable GitHub repository ID, refreshes available history, and adds new stars
under canonical `repository--owner` folders.

StarSync 2 requires Git, an initialized archive using format 2, and either Bun 1.3.14 or Node 24 or
newer. Windows, macOS, and Linux are supported.

## Install

Nothing to install — run the published CLI directly under either runtime:

```sh
npx starsync sync D:/archives/stars
bunx starsync sync D:/archives/stars
```

Both resolve `bin` to `dist/cli.js`, a node-target bundle, so Bun isn't required to use StarSync.
A first run on an empty directory still needs `init` and a `GITHUB_TOKEN`; see below.

To install it as a command instead:

```sh
npm install -g starsync
bun add -g starsync
```

### Working on StarSync

Development requires Bun. Consuming StarSync doesn't.

```sh
bun install
```

The dependency-free `prepare` guard rejects npm, yarn, and pnpm for a working copy. It runs on
`prepare` rather than `preinstall` because the guard needs Bun to execute, and a `preinstall` guard
also fires for anyone consuming the published package — which broke `npx starsync` before it ever
reached the CLI. `prepare` never runs for an install from the registry.

`prepare` then builds. `bin`, `main`, and `types` all resolve into the gitignored `dist/`, so
without that step a clone has no entry points. Building here covers the two installs that read
them from a checkout rather than a tarball — a working copy, and a Git dependency such as
`bun add git+https://github.com/NomadicDaddy/starsync` — and costs about a second on top of
`bun install`. Registry consumers get the built files from the published tarball instead.

Publish with `bun publish`. The same guard rejects `npm publish`.

## Authentication

StarSync keeps API and Git transport authentication separate:

- `GITHUB_TOKEN` is used through Octokit to authenticate the archive owner and list or resolve
  GitHub repositories. It is required by `init`, `sync`, `rename`, and `verify --force`.
- Clone and fetch operations use credentials already configured for Git, such as Git Credential
  Manager or SSH keys. The API token is never passed to Git.

Tokens and embedded Git credentials are excluded from command arguments and archive metadata.
Remote URLs and errors are sanitized before reporting. Managed origins must identify GitHub.com;
other hosts and credential-bearing URLs are rejected.

Set `GITHUB_TOKEN` in a `.env` file, in the current shell, or for one invocation:

```sh
GITHUB_TOKEN=ghp_your_token_here bun src/cli.ts sync D:/archives/stars
```

`TARGET_PATH` may supply the archive path when no positional path is given. A positional path has
priority.

## Archive contract

Every usable archive has an exact `.starsync/config.json` containing format 2 and one valid owner:

```json
{
	"archiveFormat": 2,
	"owner": {
		"id": 123456,
		"login": "archive-owner"
	}
}
```

The file accepts no extra fields. A configless directory is uninitialized, whether it is empty or
populated. Any other format is unsupported, and malformed format-2 configuration is invalid.
StarSync does not inspect such directories for checkouts or offer conversion.

Each managed checkout must store both of these local Git configuration values:

- `starsync.repository-id`: the positive stable GitHub repository ID;
- `starsync.repository-slug`: the last known `owner/name` slug.

Missing, incomplete, invalid, or duplicated identity is a current-format error. There is no
identity backfill path.

Use `init` on an existing empty directory. It authenticates the GitHub account and writes the
format-2 owner binding. Operations that authenticate compare the stable account ID, so a login
rename is accepted while a different account is rejected.

### Moving from StarSync 1.5.0

There is no in-place upgrade or conversion. Preserve the existing archive as a backup, create a
different empty directory, run `init` there, and then run `sync` to build a format-2 archive from
the account's current stars. To reuse the old path, move the existing directory aside before
creating and initializing a new empty directory at that path.

## Commands

StarSync accepts only explicit commands. Bare invocation and unknown commands are usage errors
with exit code 2. Root `--help` and command-specific help remain available.

```sh
bun src/cli.ts init [--json] [target-path]
bun src/cli.ts sync [--dry-run] [--json] [--concurrency=N] [target-path]
bun src/cli.ts verify [--force] [--json] [target-path]
bun src/cli.ts rename [--apply] [--json] [target-path]
bun src/cli.ts dates [--dry-run] [--json] [target-path]
bun src/cli.ts unlock [--force] [--json] [target-path]
```

Every command requires either `[target-path]` or `TARGET_PATH`. Missing, empty, or quoted-empty
input is a usage error and never falls back to the package directory.

### sync

`sync` lists the archive owner's current stars, adds missing repositories, refreshes recognized
checkouts, and retains repositories that are no longer starred. It identifies existing checkouts by
repository ID, not by slug or folder label. A repository rename or ownership transfer is reported
as pending while refresh continues against the existing checkout. Use `rename` to update the
label.

New repositories are cloned into a unique StarSync-owned sibling staging directory. StarSync
validates the GitHub.com origin, Git objects, archive owner, cleanliness, and identity before
atomically publishing the canonical folder. Occupied destinations are never overwritten.

Refresh fetches available remote branches and tags without pruning preserved references, then
fast-forwards to the current GitHub default branch. Divergent commits and real local changes are
blocked. Moved upstream tags retain their archived target and produce a warning. If an unavailable
Git LFS object breaks a clone or refresh, StarSync retries once with `GIT_LFS_SKIP_SMUDGE=1` and
keeps the pointer file without persisting that setting.

On platforms that cannot represent a repository path, StarSync preserves the path in Git history
and the index while excluding its working-tree copy through sparse checkout. Such paths do not
count as local work; genuine staged, unstaged, untracked, or conflicted changes still block.

Use `--dry-run` for a read-only preview and `--concurrency=N` for 1-8 concurrent repository jobs.

### verify

Without `--force`, `verify` is local and read-only. It checks Git object integrity, origins,
identity metadata, duplicate IDs, local state, canonical names, pending renames, and archive owner
binding. It requires neither a token nor network access.

`verify --force` is owner-authenticated recovery. A checkout with corrupt Git data, local changes,
or missing identity metadata is resolved and freshly cloned into a staging directory. A checkout
without identity can be resolved only when its folder already has the canonical
`repository--owner` name. The replacement must pass origin, object, owner, cleanliness, and
identity validation before publication. Failed recovery leaves the original checkout in place;
successful recovery permanently removes it. The same mode removes abandoned
`.starsync-checkout-*` staging directories while holding the archive lock.

### rename

`rename` is a read-only preview unless `--apply` is present. It resolves each checkout's current
GitHub repository identity and reports one of `blocked`, `current`, `failed`, or `pending`.

Every checkout must already contain a stable repository ID matching GitHub's resolved ID. Preview
reports missing or mismatched identity, dirty or unverifiable state, duplicate identities,
credential-bearing or invalid origins, and destination collisions without writing anything.

`rename --apply` additionally authenticates the configured archive owner. For each safe pending
checkout it updates the stored slug, normalizes `origin`, and moves the folder to
`repository--owner`. Already-current checkouts remain unchanged. Successful updates remain in
place if a later checkout is blocked, fails, collides, or the operation is interrupted. The
operation writes no temporary rename state and does not rewrite archive configuration.

### dates

`dates` is local and requires no token. It calculates each checkout's Archive Date from the newest
committer time reachable across all local Git references and aligns the folder timestamp. Use
`--dry-run` to preview.

### unlock

Every archive operation except lock recovery uses `.starsync/operation-lock.json`. StarSync
reclaims a same-host lock only after confirming its process is dead. Remote or uncertain ownership
requires `unlock --force`, which still refuses to remove a lock owned by a confirmed live local
process.

## Reporting and exit codes

Every command accepts `--json`. JSON mode writes exactly one schema-version-2 `CommandReport` to
stdout and sends progress and diagnostics to stderr. Schema 2 separates:

- checkout lifecycle: `active`, `retained`, or `blocked`;
- pending rename as a boolean state;
- current outcome: `added`, `updated`, `current`, `skipped`, or `failed`;
- optional `rename` preview with `blocked`, `current`, `failed`, or `pending` classification;
- findings with `info`, `warning`, or `error` severity.

Exit codes are 0 for success, 1 for an operational failure or blocked request, 2 for invalid usage,
and 130 after interruption. On first interrupt, StarSync stops scheduling new work, lets in-flight
Git operations finish, and emits a partial result.

## Programmatic API

The package exports command-level operations that take explicit options and return the same
`CommandReport` shape. They do not read CLI arguments, write process output, or exit. Progress uses
an optional callback and cancellation uses `AbortSignal`.

`main` resolves to `dist/index.js`, a node-target ESM bundle, and `types` to declarations emitted
from the same sources, so the API is available under Bun and under Node 24 or newer. Node can also
reach it through `require`, which loads ESM natively on the supported versions.

```ts
import { renameArchive, syncArchive } from 'starsync';

const sync = await syncArchive({
	dryRun: true,
	targetPath: 'D:/archives/stars',
	token: process.env.GITHUB_TOKEN ?? '',
});

const renames = await renameArchive({
	targetPath: 'D:/archives/stars',
	token: process.env.GITHUB_TOKEN ?? '',
});
```

Supported operations are `initArchive`, `syncArchive`, `verifyArchive`, `renameArchive`,
`normalizeArchiveDates`, and `unlockArchive`.

## Release validation

A release candidate requires all of the following:

1. The Windows, macOS, and Linux release matrix installs from `bun.lock`, runs `smoke:qc`, builds
   the bundle, and compiles the platform executable with archive credentials unset.
2. The reviewed live archive passes read-only `verify --json` and a complete `rename --json`
   preview. Evidence is stored outside the archive and refreshed if the archive changes.
3. The offline copied-format-2 journey runs rename, verification, synchronization, and Archive
   Date normalization. The opt-in live smoke runs only against a caller-created temporary copy.

The live smoke requires `STARSYNC_LIVE_SMOKE=1`, `GITHUB_TOKEN`, and an explicit temporary target.
It rejects the configured `TARGET_PATH`.

```sh
bun run smoke:live -- <temporary-managed-archive>
```

## Scripts

| Script                    | Purpose                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `bun run sync`            | Run the explicit sync command                                  |
| `bun run build`           | Bundle the CLI into `dist/`                                    |
| `bun run compile`         | Compile the standalone executable into `dist/`                 |
| `bun run smoke:qc`        | Run source-shape, type, lint, format, and test gates           |
| `bun run smoke:live`      | Run the opt-in read-only smoke against an explicit archive copy |
| `bun run format`          | Format source, scripts, and tests                              |

Schedule the explicit `sync` command with Task Scheduler, cron, launchd, or another periodic
runner. A non-zero exit lets the scheduler surface failures.

## License

MIT
