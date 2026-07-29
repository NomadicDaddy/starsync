# Require an explicit archive target

**Status:** Accepted

**Decision date:** 2026-07-23

## Context

A packaged or scheduled CLI cannot safely infer an archive from its installation directory or
current working directory. An implicit path could create or modify repository data somewhere the
caller did not intend.

## Decision

Every StarSync command requires either a positional `[target-path]` or `TARGET_PATH`. The
positional value has priority. Missing or quoted-empty input is a usage error with exit code 2 and
must not create files.

The deprecated bare 1.x invocation remains an alias for `sync`, but it follows the same explicit
target rule.

## Implementation

- [`src/lib/subcommands.ts`](../../src/lib/subcommands.ts) enforces required CLI targets before
  calling an archive operation.
- [`src/lib/cli-utils.ts`](../../src/lib/cli-utils.ts) applies positional-over-environment
  resolution and quote stripping.
- [`src/lib/archive-api.ts`](../../src/lib/archive-api.ts) requires a non-empty explicit
  `targetPath` from library consumers.

## Consequences

First-time callers must choose a directory, and automation must declare its archive explicitly.
In return, no command silently creates or modifies an archive relative to the package or process
working directory.
