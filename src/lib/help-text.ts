const HOST_OPTION =
	'  --host HOST       Select github.com or codeberg.org; also accepts --host=HOST';
const TARGET_ENVIRONMENT = `  TARGET_PATH_GITHUB    GitHub default when no positional path is given.
  TARGET_PATH_CODEBERG  Codeberg default when --host codeberg.org selects it.
  TARGET_PATH           GitHub-only fallback if TARGET_PATH_GITHUB is absent.`;
const TARGET_SELECTION = `A positional path overrides environment defaults and uses the recorded archive host.
Without --host, default-path selection uses GitHub. An explicit --host must match an
initialized archive's host. Missing or empty paths refuse; Codeberg never uses a GitHub default.`;

export const ROOT_HELP_TEXT = `starsync - archive command suite for GitHub and Codeberg starred repositories.

Usage:
  starsync <command> [options] [target-path]
  npx starsync <command> [options] [target-path]
  bunx starsync <command> [options] [target-path]

Commands:
  sync       Add or refresh managed checkouts by stable repository identity
  verify     Inspect the archive for integrity without changing it
  rename     Preview or apply canonical checkout renames
  dates      Normalize managed checkout folders to their Archive Dates
  init       Initialize a managed archive with owner and format
  unlock     Release an archive operation lock

Options:
${HOST_OPTION}
  --help, -h        Show help (use after a subcommand for subcommand help)
  --json            Emit one schema-versioned JSON result document on stdout
  --dry-run         Sync/dates: preview without changing the archive
  --concurrency=N   Sync only: concurrent repository processing (default: 4, range: 1-8)
  --min-free-space=SIZE
                    Sync and verify --force: free space required before any repository
                    work (default: 1GB, 0 disables the check)
  --apply           Rename only: apply the previewed slug, origin, and folder updates
  --force           Verify: re-clone damaged or locally modified checkouts. Unlock:
                    remove a remote or
                    uncertain lock after assessing the risk

Environment:
  GITHUB_TOKEN      GitHub archive token for init, sync, rename, and verify --force.
  CODEBERG_TOKEN    Codeberg archive token for the same commands.
${TARGET_ENVIRONMENT}

${TARGET_SELECTION}

Run 'starsync <command> --help' for command-specific options.`;

export const SYNC_HELP_TEXT = `starsync sync - add or refresh managed checkouts by stable repository identity.

Usage:
  starsync sync [options] [target-path]
  npx starsync sync [options] [target-path]
  bunx starsync sync [options] [target-path]

Options:
${HOST_OPTION}
  --help, -h          Show this help
  --json              Emit one schema-versioned JSON result document on stdout
  --dry-run           Query stars and inspect the archive without cloning, pulling,
                      renaming, or modifying any Git data, folder names, or timestamps
  --concurrency=N     Number of repositories to process concurrently (default: 4,
                      range: 1-8; --concurrency=1 is sequential and deterministic)
  --min-free-space=SIZE
                      Free space the archive filesystem must have at startup, measured
                      once before any repository work (default: 1GB). Accepts a byte
                      count or a B, KB, MB, GB, or TB suffix (KiB, MiB, GiB, TiB are
                      accepted as the same binary multiples); --min-free-space=0
                      disables the check. A dry run reports a shortfall as a warning
                      instead of failing.

Environment:
  GITHUB_TOKEN        Required for GitHub archives (repo + read:user scopes).
  CODEBERG_TOKEN      Required for Codeberg archives.
${TARGET_ENVIRONMENT}

${TARGET_SELECTION}`;

export const VERIFY_HELP_TEXT = `starsync verify - inspect the archive for Git integrity and identity inconsistencies.

Usage:
  starsync verify [options] [target-path]
  npx starsync verify [options] [target-path]
  bunx starsync verify [options] [target-path]

Options:
${HOST_OPTION}
  --help, -h        Show this help
  --json            Emit one schema-versioned JSON result document on stdout
  --force           Replace checkouts that fail Git integrity, contain local changes, or lack
                    identity metadata; remove abandoned clone staging directories
  --min-free-space=SIZE
                    Free space the archive filesystem must have before --force replaces
                    any checkout, measured once after abandoned staging directories are
                    removed (default: 1GB). Accepts a byte count or a B, KB, MB, GB, or
                    TB suffix (KiB, MiB, GiB, TiB are accepted as the same binary
                    multiples); --min-free-space=0 disables the check. Read-only
                    verification preserves checkout content and never measures;
                    read-only operations and previews still use a transient operation lock.

Environment:
  GITHUB_TOKEN      Required with --force for GitHub archives.
  CODEBERG_TOKEN    Required with --force for Codeberg archives.
${TARGET_ENVIRONMENT}

${TARGET_SELECTION}
Without --force, verification is local and read-only. Missing identity can be recovered only from
a canonical folder. Forced recovery preserves a checkout until its replacement clone passes
origin, object, owner, and identity validation.`;

export const RENAME_HELP_TEXT = `starsync rename - preview or apply canonical checkout renames.

Usage:
  starsync rename [options] [target-path]
  npx starsync rename [options] [target-path]
  bunx starsync rename [options] [target-path]

Options:
${HOST_OPTION}
  --help, -h        Show this help
  --json            Emit one schema-versioned JSON result document on stdout
  --apply           Update repository slugs and origins, and safely rename folders

Environment:
  GITHUB_TOKEN      Required for GitHub archives.
  CODEBERG_TOKEN    Required for Codeberg archives.
${TARGET_ENVIRONMENT}

${TARGET_SELECTION}
Without --apply, rename is read-only. Apply requires existing stable checkout identities,
preserves blocked local work, and reports partial success without temporary state.`;

export const DATES_HELP_TEXT = `starsync dates - normalize managed checkout folders to their Archive Dates.

Usage:
  starsync dates [options] [target-path]
  npx starsync dates [options] [target-path]
  bunx starsync dates [options] [target-path]

Options:
${HOST_OPTION}
  --help, -h        Show this help
  --json            Emit one schema-versioned JSON result document on stdout
  --dry-run         Preview timestamp repairs without modifying the archive

Environment:
${TARGET_ENVIRONMENT}

${TARGET_SELECTION}
Archive Date is the newest committer time reachable from any local Git reference.
Date calculation is local and does not use API tokens or network access.`;

export const INIT_HELP_TEXT = `starsync init - initialize a managed archive with owner and format.

Usage:
  starsync init [options] [target-path]
  npx starsync init [options] [target-path]
  bunx starsync init [options] [target-path]

Options:
  --help, -h        Show this help
  --json            Emit one schema-versioned JSON result document on stdout
${HOST_OPTION}

Environment:
  GITHUB_TOKEN      Required for github.com (repo + read:user scopes).
  CODEBERG_TOKEN    Required for codeberg.org (read:user and read:repository scopes).
${TARGET_ENVIRONMENT}

${TARGET_SELECTION}

The target directory must already exist and be empty. Each archive belongs to one host and
account. Initialization defaults to github.com; later commands use the recorded host.`;

export const UNLOCK_HELP_TEXT = `starsync unlock - release an archive operation lock.

Usage:
  starsync unlock [options] [target-path]
  npx starsync unlock [options] [target-path]
  bunx starsync unlock [options] [target-path]

Options:
${HOST_OPTION}
  --help, -h        Show this help
  --json            Emit one schema-versioned JSON result document on stdout
  --force           Remove a remote or uncertain lock after confirming no operation
                    still uses the archive; never overrides a confirmed live local owner

Environment:
${TARGET_ENVIRONMENT}

${TARGET_SELECTION}

Confirmed-dead same-host locks are removed without --force.`;
