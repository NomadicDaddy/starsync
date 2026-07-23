export const ROOT_HELP_TEXT = `starsync - archive command suite for GitHub starred repositories.

Usage:
  starsync <command> [options] [target-path]
  starsync [options] [target-path]        (deprecated alias for 'sync')
  bun src/cli.ts <command> [options] [target-path]

Commands:
  sync       Clone or pull every starred GitHub repository (1.x)
  verify     Inspect the archive for integrity without changing it (1.x)
  migrate    Preview migration of a legacy archive (preview-only in 1.x)
  dates      Set each repo folder's mtime to its latest commit time (1.x)
  init       Initialize a managed archive with owner and format (2.0)
  unlock     Release an archive operation lock (2.0)

Options:
  --help, -h        Show help (use after a subcommand for subcommand help)
  --json            Emit one schema-versioned JSON result document on stdout
  --dry-run         Sync only: query stars and inspect without changing anything
  --concurrency=N   Sync only: concurrent repository processing (default: 4, range: 1-8)
  --apply           Migrate only: apply migration (not available in 1.x)

Environment:
  GITHUB_TOKEN      Required for init and sync. Personal access token with repo + read:user scopes.
  TARGET_PATH       Required if no positional target-path is given.

Run 'starsync <command> --help' for command-specific options.`;

export const SYNC_HELP_TEXT = `starsync sync - clone or pull every starred GitHub repository.

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

Environment:
  TARGET_PATH       Required if no positional target-path is given.

A positional target-path argument overrides TARGET_PATH.
Verification is local and read-only; it does not use GITHUB_TOKEN or network access.`;

export const MIGRATE_HELP_TEXT = `starsync migrate - preview migration of a legacy archive.

Usage:
  starsync migrate [options] [target-path]
  bun src/cli.ts migrate [options] [target-path]

Options:
  --help, -h        Show this help
  --json            Emit one schema-versioned JSON result document on stdout
  --apply           Apply the migration (not available in 1.x; preview-only)

Environment:
  TARGET_PATH       Required if no positional target-path is given.

A positional target-path argument overrides TARGET_PATH.`;

export const DATES_HELP_TEXT = `starsync dates - set each repo folder's mtime to its latest commit time.

Usage:
  starsync dates [options] [target-path]
  bun src/cli.ts dates [options] [target-path]

Options:
  --help, -h        Show this help
  --json            Emit one schema-versioned JSON result document on stdout
  --dry-run         Print actions without modifying timestamps

Environment:
  TARGET_PATH       Required if no positional target-path is given.

A positional target-path argument overrides TARGET_PATH.`;

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

Environment:
  TARGET_PATH       Required if no positional target-path is given.

Not available in this release.`;

const SUBCOMMAND_HELP: Record<string, string> = {
	dates: DATES_HELP_TEXT,
	init: INIT_HELP_TEXT,
	migrate: MIGRATE_HELP_TEXT,
	sync: SYNC_HELP_TEXT,
	unlock: UNLOCK_HELP_TEXT,
	verify: VERIFY_HELP_TEXT,
};

export const getSubcommandHelp = (subcommand: string): string => {
	const text = SUBCOMMAND_HELP[subcommand];
	if (!text) {
		throw new Error(`No help text registered for subcommand: ${subcommand}`);
	}
	return text;
};
