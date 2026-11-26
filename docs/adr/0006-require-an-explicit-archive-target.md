# Require an explicit archive target

**Status:** Accepted

**Decision date:** 2026-07-23

## Context

A packaged or scheduled CLI cannot safely infer an archive from its installation directory or
current working directory. An implicit path could create or modify repository data somewhere the
caller did not intend.

## Decision

Every StarSync archive command requires either a positional `[target-path]` or an explicit
environment default. The positional value has priority. GitHub uses `TARGET_PATH_GITHUB`, falling
back to `TARGET_PATH` only when the host-specific variable is absent. Codeberg uses
`TARGET_PATH_CODEBERG` when selected with `--host codeberg.org`; it never falls back to a GitHub
default. Without `--host`, environment-default selection uses GitHub. Missing or quoted-empty
input is a usage error with exit code 2 and must not create files. Help does not require a target.

A positional path uses the archive's recorded host unless an explicit `--host` contradicts it.
Environment defaults must match the selected host. Initialization defaults to GitHub unless
`--host codeberg.org` is supplied.

Bare invocation is invalid. Callers must select `sync`, `verify`, `rename`, `dates`, `init`, or
`unlock`; root `--help` (or `-h`) is the only root-level action.

## Implementation

- [`src/lib/subcommands.ts`](../../src/lib/subcommands.ts) enforces required CLI targets before
  calling an archive operation.
- [`src/lib/cli-target.ts`](../../src/lib/cli-target.ts) selects host-specific defaults, gives
  positional paths priority, and rejects host mismatches before invoking archive operations.
- [`src/lib/cli-utils.ts`](../../src/lib/cli-utils.ts) provides path resolution and quote stripping.
- [`src/lib/archive-api.ts`](../../src/lib/archive-api.ts) requires a non-empty explicit
  `targetPath` from library consumers.

## Consequences

First-time callers must choose a directory, and automation must declare its archive explicitly.
In return, no command silently creates or modifies an archive relative to the package or process
working directory.
