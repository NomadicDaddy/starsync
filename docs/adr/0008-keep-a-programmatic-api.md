# Keep a programmatic API

**Status:** Accepted

**Decision date:** 2026-07-23

## Context

StarSync is used both as an interactive or scheduled command and as a Bun package. Process-coupled
helpers required library consumers to construct CLI arguments, parse output, or tolerate process
side effects.

## Decision

StarSync exposes command-level archive operations for initialization, synchronization,
verification, repository renames, Archive Date normalization, and lock release. Each operation accepts
explicit options and returns the same schema-versioned `CommandReport` used by CLI JSON output.

Long-running operations support an optional progress callback and `AbortSignal`. Library
operations do not read `process.argv`, write to stdout or stderr, or exit the process. The project
remains Bun-only; adding Node.js runtime support would create a second runtime and test contract.

The package entry point exposes only the current command-level archive operations and their
reporting and identity types.

## Implementation

- [`src/index.ts`](../../src/index.ts) is the supported package entry point.
- [`src/lib/archive-api.ts`](../../src/lib/archive-api.ts) implements `initArchive`,
  `syncArchive`, `verifyArchive`, `renameArchive`, and `normalizeArchiveDates`.
- [`src/lib/archive-unlock.ts`](../../src/lib/archive-unlock.ts) implements `unlockArchive`.
- [`src/lib/reporting.ts`](../../src/lib/reporting.ts) defines the shared `CommandReport`.
- [`src/lib/subcommands.ts`](../../src/lib/subcommands.ts) adapts CLI inputs and streams to the
  library operations.

## Consequences

CLI and library users share one behavior and reporting contract. Schedulers and local tools can
consume typed results directly without subprocess parsing, while the CLI remains a thin adapter
over the same operations.
