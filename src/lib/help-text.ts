export const ROOT_HELP_TEXT = `starsync - archive command suite for GitHub starred repositories.

Usage:
  starsync <command> [options] [target-path]
  npx starsync <command> [options] [target-path]
  bunx starsync <command> [options] [target-path]
  bun src/cli.ts <command> [options] [target-path]

Commands:
  sync       Add or refresh managed checkouts by stable repository identity
  verify     Inspect the archive for integrity without changing it
  rename     Preview or apply canonical checkout renames
  dates      Normalize managed checkout folders to their Archive Dates
  init       Initialize a managed archive with owner and format
  unlock     Release an archive operation lock

Options:
  --help, -h        Show help (use after a subcommand for subcommand help)
  --json            Emit one schema-versioned JSON result document on stdout
  --dry-run         Sync/dates: preview without changing the archive
  --concurrency=N   Sync only: concurrent repository processing (default: 4, range: 1-8)
  --apply           Rename only: apply the previewed slug, origin, and folder updates
  --force           Verify: re-clone damaged or locally modified checkouts. Unlock:
                    remove a remote or
                    uncertain lock after assessing the risk

Environment:
  GITHUB_TOKEN      Required for init, sync, rename, and verify --force.
  TARGET_PATH       Required if no positional target-path is given.

Run 'starsync <command> --help' for command-specific options.`;

export const SYNC_HELP_TEXT = `starsync sync - add or refresh managed checkouts by stable repository identity.

Usage:
  starsync sync [options] [target-path]
  bun src/cli.ts sync [options] [target-path]

Options:
  --help, -h          Show this help
  --json              Emit one schema-versioned JSON result document on stdout
  --dry-run           Query stars and inspect the archive without cloning, pulling,
                      renaming, or modifying any Git data, folder names, or timestamps
  --concurrency=N     Number of repositories to process concurrently (default: 4,
                      range: 1-8; --concurrency=1 is sequential and deterministic)

Environment:
  GITHUB_TOKEN        Required. Personal access token with repo + read:user scopes.
  TARGET_PATH         Required if no positional target-path is given.

A positional target-path argument overrides TARGET_PATH.`;

export const VERIFY_HELP_TEXT = `starsync verify - inspect the archive for Git integrity and identity inconsistencies.

Usage:
  starsync verify [options] [target-path]
  bun src/cli.ts verify [options] [target-path]

Options:
  --help, -h        Show this help
  --json            Emit one schema-versioned JSON result document on stdout
  --force           Replace checkouts that fail Git integrity, contain local changes, or lack
                    identity metadata; remove abandoned clone staging directories

Environment:
  GITHUB_TOKEN      Required with --force to resolve repository identities.
  TARGET_PATH       Required if no positional target-path is given.

A positional target-path argument overrides TARGET_PATH.
Without --force, verification is local and read-only. Missing identity can be recovered only from
a canonical folder. Forced recovery preserves a checkout until its replacement clone passes
origin, object, owner, and identity validation.`;

export const RENAME_HELP_TEXT = `starsync rename - preview or apply canonical checkout renames.

Usage:
  starsync rename [options] [target-path]
  bun src/cli.ts rename [options] [target-path]

Options:
  --help, -h        Show this help
  --json            Emit one schema-versioned JSON result document on stdout
  --apply           Update repository slugs and origins, and safely rename folders

Environment:
  GITHUB_TOKEN      Required. Resolves repositories; apply also authenticates the archive owner.
  TARGET_PATH       Required if no positional target-path is given.

A positional target-path argument overrides TARGET_PATH.
Without --apply, rename is read-only. Apply requires existing stable checkout identities,
preserves blocked local work, and reports partial success without temporary state.`;

export const DATES_HELP_TEXT = `starsync dates - normalize managed checkout folders to their Archive Dates.

Usage:
  starsync dates [options] [target-path]
  bun src/cli.ts dates [options] [target-path]

Options:
  --help, -h        Show this help
  --json            Emit one schema-versioned JSON result document on stdout
  --dry-run         Preview timestamp repairs without modifying the archive

Environment:
  TARGET_PATH       Required if no positional target-path is given.

A positional target-path argument overrides TARGET_PATH.
Archive Date is the newest committer time reachable from any local Git reference.
Date calculation is local and does not use GITHUB_TOKEN or network access.`;

export const INIT_HELP_TEXT = `starsync init - initialize a managed archive with owner and format.

Usage:
  starsync init [options] [target-path]
  bun src/cli.ts init [options] [target-path]

Options:
  --help, -h        Show this help
  --json            Emit one schema-versioned JSON result document on stdout

Environment:
  GITHUB_TOKEN      Required. Personal access token with repo + read:user scopes.
  TARGET_PATH       Required if no positional target-path is given.

The target directory must already exist and be empty.`;

export const UNLOCK_HELP_TEXT = `starsync unlock - release an archive operation lock.

Usage:
  starsync unlock [options] [target-path]
  bun src/cli.ts unlock [options] [target-path]

Options:
  --help, -h        Show this help
  --json            Emit one schema-versioned JSON result document on stdout
  --force           Remove a remote or uncertain lock after confirming no operation
                    still uses the archive; never overrides a confirmed live local owner

Environment:
  TARGET_PATH       Required if no positional target-path is given.

Confirmed-dead same-host locks are removed without --force.`;
