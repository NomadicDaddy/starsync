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
operations do not read `process.argv`, write to stdout or stderr, or exit the process. The original
July 23 decision kept the project Bun-only; the distribution contract described below subsequently
added Node.js runtime support.

The package entry point exposes the six command-level archive operations, their option and
reporting types, `DEFAULT_ARCHIVE_CONCURRENCY`, and the identity configuration key constants
`REPOSITORY_ID_KEY` and `REPOSITORY_SLUG_KEY`. `CheckoutIdentity` itself is not a public export.

## Implementation

The August 3 distribution contract extended the CLI and programmatic API to Node.js 24 or later:
both published bundles target Node, and declarations resolve for NodeNext and bundler consumers.
Bun remains the development package manager and test runner. This extension preserves the shared
command API.

- [`src/index.ts`](../../src/index.ts) is the supported package entry point.
- [`src/lib/archive-api.ts`](../../src/lib/archive-api.ts) implements `initArchive`,
  `syncArchive`, `verifyArchive`, `renameArchive`, and `normalizeArchiveDates`.
- [`src/lib/archive-unlock.ts`](../../src/lib/archive-unlock.ts) implements the synchronous
  `unlockArchive`; the other five operations return `Promise<CommandReport>`.
- [`src/lib/archive-api-contract.ts`](../../src/lib/archive-api-contract.ts) defines the shared
  options. Initialization and unlock options are defined alongside their implementations.
- [`src/lib/archive-operation-lock.ts`](../../src/lib/archive-operation-lock.ts) wraps the five
  asynchronous operations in a transient lock when the target is an existing directory, including
  read-only verification and previews. Unlock performs lock recovery directly.
- [`src/lib/reporting.ts`](../../src/lib/reporting.ts) defines the shared `CommandReport`.
- [`src/lib/subcommands.ts`](../../src/lib/subcommands.ts) adapts CLI inputs and streams to the
  library operations.

## Consequences

CLI and library users share one behavior and reporting contract. Schedulers and local tools can
consume typed results directly without subprocess parsing, while the CLI remains a thin adapter
over the same operations.
