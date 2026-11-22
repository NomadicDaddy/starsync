# Changelog

All notable changes to this project will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.5.2] - 2026-11-22

### Security

- Sync, rename and verification now refuse an archive entry that could send Git outside the
  archive, and report it as `checkout-outside-archive`: a link or junction in place of a checkout,
  a `.git` file or link that redirects Git, Git metadata that names a common directory, a folder
  that resolves outside the archive root, or a checkout whose work tree, Git directory or common
  directory Git itself resolves elsewhere, as a `core.worktree` setting can. The check runs before
  each checkout's identity is read, and rename apply repeats it before reading identity and again
  after moving the folder, before writing metadata. Before, sync could fetch into, and write
  identity metadata for, a repository a planted link pointed at, and rename could act on it. A
  link or junction now also counts as an occupied name, so sync won't clone through it.
- When Git can't open a checkout at all, for example because its `.git/config` is damaged,
  StarSync no longer runs any further Git in it. Verification reports it as
  `checkout-boundary-unverified`, and `verify --force` leaves the folder and its local work as
  they are for you to recover or remove. Before, forced repair could replace it and discard
  uncommitted files. A checkout Git can open but whose objects are damaged is still replaced as
  before.

### Known limitations

These were present in 2.4.1 and are not fixed in this release. Each is recorded for a later
2.5.x release.

- Octokit's own request logger can write a GitHub request id to standard error when an API call
  fails, outside StarSync's sanitized output. It doesn't carry the token.
- `unlock` follows a `.starsync` folder that is a link, so it can read and remove the operation
  lock of the archive the link points to. It removes only that fixed lock file.
- For contributors only: `scripts/live-smoke.ts` prints its errors and reports without the shared
  output sanitizer, full QC has no dependency-advisory step, and the lint toolchain still resolves
  minimatch 10.2.6 (GHSA-g3hv-75wg-m249, a development-only resource-exhaustion advisory).
- Release checks: of the 26 project audits that apply to StarSync, only the security and
  secret-handling audits were run for this release. The other 24 were last run before 2.5.0, or
  in one case never. Older review findings from the first 60 commits after 2.4.1 aren't all
  traced to their follow-ups, and the project's priority history can't be compared with 2.4.1's
  because it isn't kept in Git.

## [2.5.1] - 2026-11-22

### Security

- A GitHub API failure is now reported as the operation, the HTTP status and, when the rate
  limit is exhausted, its reset time, for example
  `GitHub API request failed (HTTP 401) while reading the authenticated account.` Octokit's own
  error text is no longer passed on, because a provider can echo the request's credentials in its
  response body. Codeberg failures already worked this way.
- Error and report sanitizing now redacts the values of secret fields in JSON, including JSON
  nested inside a JSON string. A field counts when its decoded name ends in authorization, auth,
  api key, access key, private key, secret, token, password, passwd, pwd or cookie, so
  `"access_token"`, `"accessToken"`, `"Set-Cookie"` and a name written with `\u` escapes all match.
  The redacted JSON stays valid, and other keys and values are left as they were. That holds too
  when a plain-text Authorization header, Bearer value or `password=` pair sits inside a JSON
  string.
  Before, an opaque credential in a quoted Authorization field reached reports, progress and JSON
  output unchanged.
- The repository now ignores every dotenv file Bun loads, including the `.env.development`,
  `.env.production` and `.env.test` overlays, so a token placed in one can't be committed by
  accident. `.env.example` stays trackable, and a test checks each file against the ignore rules.
  This affects contributors to this repository only, not installed copies of StarSync.

## [2.5.0] - 2026-11-22

### Added

- Shared StarSync project logo in the GitHub README, displayed as a contained square.
- Separate `TARGET_PATH_GITHUB` and `TARGET_PATH_CODEBERG` archive defaults, selected by
  `--host` on every archive command. Positional paths take priority; `TARGET_PATH` remains
  a GitHub-only fallback. Default-path and explicit host/archive mismatches refuse before operating.
  If `TARGET_PATH` points to a Codeberg archive, move that value to `TARGET_PATH_CODEBERG`
  and select it with `--host codeberg.org`.
- Codeberg archives alongside GitHub archives. `init --host codeberg.org` binds an archive
  to one Codeberg account. Initialization, sync, rename and `verify --force` use
  `CODEBERG_TOKEN` for Codeberg archives and keep identities scoped to that host.
  Read-only verification, dates and unlock require no API token. Existing format-2 archives
  keep their GitHub default without a migration, and an archive cannot mix hosts.
  Other Forgejo hosts are not supported.
- `bun run check:dead-code` checks project files and exports with Knip before the test suite.
  Shared files retain their documented owner-specific exemptions.

### Changed

- Shared hooks and quality tooling are now delivered from tagged smokestack versions and
  checked against `smokestack.lock`. Shared-file checks tolerate checkout line-ending
  differences, report skipped repository roots, and verify that hook setup is an executable
  command step rather than a comment or incidental mention.
- The full quality gate runs through the smokestack runner, checks the delivered files first,
  then runs every existing check and reports all failures before exiting. The fast gate keeps
  its four static checks and stops at the first failure.
- The README's quick start now creates an empty directory, supplies the host's API token and runs
  `init` before the first `sync`; an existing format-2 archive runs `sync` alone.
- Development tooling (none of it ships in the CLI or library bundles):
    - Updated ESLint to 10.15.0 and Prettier to 3.10.1, and the development toolchain to the
      approved November fleet targets (knip 6.45.1, typescript-eslint 8.72.2). ESLint, its
      sorting and TypeScript plugins, Knip and the Bun type definitions follow the workspace
      dependency targets. TypeScript remains pinned to 6.0.3.
    - Took smokestack's shared files from v0.7.0 through v1.0.5: the history guard and
      shared-core sync (v0.7.0), unused exports removed (v0.7.1), the leak guard's setup split
      into its own script and its self-test isolated from global git configuration (v0.7.2,
      v0.7.3), and unchanged files a group no longer delivers removed (v0.9.0).
    - The v0.10.8 delivery: the leak guard scans added lines that look like diff headers, and a
      key body after a line with no final newline. The v0.10.10 delivery: a delivery stays
      pending until its target commits or restores it. The v0.10.11 delivery: an interrupted
      gate on Linux or macOS also stops a step's detached grandchild processes. The v0.10.12
      delivery: the hooks path is read and written per checkout under
      `extensions.worktreeConfig`.
    - The v1.0.4 delivery: shared groups reach a repository by its lock's own declaration, and
      a step keyed on a script with a shebang is keyed on what that script imports. The v1.0.5
      delivery: when a full-gate step runs a delivered command marked fast, a fast step must run
      that same command (starsync's full gate runs neither marked command), and the delivered
      lock writer's planning moved into its own file (lock-write.ts split into lock-plan.ts).

### Fixed

- Forced verification preserves checkouts with foreign or credential-bearing origins, duplicate
  identities, or mismatched identity metadata instead of replacing them.
- Rename resolution and forced recovery use the stored repository ID when available, so
  repository renames and transfers can be resolved on the archive's host.
- README rename-preview guidance now distinguishes preserved checkout content from transient
  operation-lock writes; the lint reference includes unused-disable reporting.
- Git hooks find Git's Bash by absolute path on Windows, avoiding the unrelated WSL launcher
  when it appears first on `PATH`.
- Knip discovers package-script entry points itself, so deleting a script can expose its
  orphaned file. Formatting checks now cover `knip.json`, and its CLI discovery explanation
  names the `start` and `sync` scripts that actually reach the source entry point.

### Security

- Updated the locked `brace-expansion` development dependency from 5.0.9 to 5.0.12,
  fixing three denial-of-service advisories in the lint toolchain. Runtime dependencies
  and the TypeScript 6.0.3 pin are unchanged.
- Codeberg requests reject redirects, validate responses, and fail on repeated repository
  identities during pagination. API tokens remain separate from Git authentication and
  are never written to archive configuration or passed to clone and fetch commands.
- Agent-issued pushes are blocked when they would delete a remote ref or rewrite its history.
- Commit guards recover configured private-pattern locations from the Windows user setting,
  refuse missing, unreadable or invalid configured patterns, and report matching files and
  counts without printing the refused text. A tracked publication allowlist clears only
  matching private-name patterns, never secret formats or home-directory paths.

## [2.4.1] - 2026-09-10

### Changed

- Bun installations now require 1.4.2 or newer. Release CI reads the Bun version from
  `package.json` so it can install the current lockfile. Node 24 remains supported.
- Synchronized the shared release guards and gate manifest. Screenshot requirements now come
  from the tagged tree, and opted-in captures must match the release commit, production build,
  routes, and image hashes. StarSync remains exempt as a CLI without a capture declaration.

## [2.4.0] - 2026-08-11

### Added

- `smoke:qc` now checks StarSync's shared hooks, license helpers, manifests, and gate scripts
  against their owning repositories. The checker reports absent and drifted copies separately and
  refuses writes from repositories that do not own a shared group.

### Changed

- License attribution now recognizes packages excluded by platform constraints, including
  constraints inherited through dependency edges, without treating a valid install as incomplete.
- CLI help and README examples use the published `npx starsync` and `bunx starsync` commands. The
  npm package also links directly to its repository, issue tracker, and homepage.
- The release screenshot guard now reads a tracked `.screenshot-capture` declaration. StarSync is a
  headless CLI and does not declare release captures, so tags no longer depend on untracked folders.

### Fixed

- Shared-core validation now rejects empty target filters, keeps existing carriers synchronized
  when a group's discovery marker changes, and stops before comparison if an owner's full and
  fallback variants have collapsed to identical files.

### Security

- The commit-time leak guard permits a repository to name itself while continuing to block private
  sibling names. Private-key detection now requires key material, accepts harmless placeholders,
  and catches a key body added below a header that was committed earlier.

## [2.3.0] - 2026-08-04

### Added

- A startup free-space reserve for `sync`. After taking the archive lock and clearing abandoned owned
  artifacts, `sync` measures the filesystem holding the archive and refuses to go on when less than
  1GB is available, before it fetches stars or processes any repository. This is one measurement at
  startup: it does not size the pending clones, reserve capacity, or measure again during the run, so
  it stops a run that begins on a too-full disk rather than guaranteeing one that begins above the
  minimum will finish. `--min-free-space=SIZE` sets another minimum, as a byte count or with a `B`,
  `KB`, `MB`, `GB`, or `TB` suffix, each a binary multiple, and `--min-free-space=0` disables the
  check. The programmatic API takes the same value as `minFreeSpace` in bytes. A dry run reports a
  shortfall as a warning and still previews the work, since a preview writes nothing. A filesystem
  StarSync cannot measure produces a warning rather than a refusal.
- The same reserve for `verify --force`, which clones replacements and so needs the room `sync`
  does. It is measured after the abandoned owned artifacts are cleared and before any checkout is
  replaced, and a shortfall refuses with exit 1. `--min-free-space=SIZE` and the `minFreeSpace`
  option take the same values and the same 1GB default as on `sync`. Read-only `verify` writes
  nothing and never measures.

### Fixed

- The reserve is measured at the target's nearest existing ancestor when the target itself does not
  exist, since both share one filesystem. No command reaches that case today, because the archive
  guard rejects a missing target first; the fallback keeps a future caller from reading an absent
  path as an unmeasurable filesystem.
- Git subprocesses now request hidden Windows process windows on every path. The async `execFile`
  and sync `execFileSync` Git launches ran without `windowsHide`, and the visibility guard could
  not detect `execFile(Sync)` call sites, so it passed while the production Git paths violated the
  invariant it claimed to enforce.
- A clone or fetch that fails because another process is holding a file open is retried, the same
  way a dropped connection already was. Only network transport counted as transient before, so
  filesystem contention was the one class of transient failure with no retry at all. On Windows an
  indexer, a scanner, or a Git child that has not fully exited denies the unlink or the rename
  outright, which failed work that would have succeeded moments later. An SSH `Permission denied
(publickey)` is still a hard authentication failure, because authentication is classified first.
- `bun run check:leak-guard` and the `prepare` hook resolve the `bash` that ships beside the running
  Git rather than the first one on `PATH`. On Windows `C:\Windows\System32\bash.exe` is the WSL
  launcher, and it shadows Git's bash in every PowerShell and cmd session; with no distro installed
  it exits on a relay error naming neither the script nor the shell it wanted. This reached a
  release rather than a developer: `prepublishOnly` runs `smoke:qc`, `smoke:qc` runs the leak-guard
  self-test, and the 2.2.1 publish died there.

### Removed

- Dropped the `compile` and `deploy` scripts, the standalone-binary build and its release-matrix
  step, and the license scope section that described it. StarSync ships through the npm registry
  only; the compiled executable was never published, so `bun run build` is the whole build.

## [2.2.1] - 2026-08-03

### Changed

- `bun run smoke:qc:fast` lints through a new `lint:fast` that passes ESLint's `--cache`, while the
  full `smoke:qc` keeps running the uncached `lint`. That cache keys on each file's own content,
  which the type-aware rules outlive: a type change in one file can create a violation in another
  the cache then treats as unchanged and skips. The inner loop takes that trade for speed, and the
  authoritative gate does not. `smoke:qc` also names its own static steps now rather than delegating
  the first four to `smoke:qc:fast`, which would have handed it the cached lint.
- The ESLint rule set matches the aidd and Spernakit repositories. Seven perfectionist sort rules
  that were missing here are enabled, every perfectionist rule and `consistent-type-imports` reports
  at error rather than warn, and the lint scripts pass `--report-unused-disable-directives`. A file
  shared between the three repositories can no longer pass lint in one and fail it in another. The
  reorders this produced cover import specifiers and one intersection type, with no behavior change.

### Fixed

- The shared license core writes its skipped `node_modules` entries in sorted order, so the copy
  StarSync carries lints clean in the repository it is maintained in.

## [2.2.0] - 2026-08-03

### Added

- StarSync now generates its own third-party attribution from the lockfile.
  `THIRD_PARTY_LICENSES.md` records the license of every declared dependency and of the closure
  resolved beneath them, and `THIRD_PARTY_NOTICES.md` reproduces each package's own copyright line
  and terms. `bun run licenses:generate` writes both; `bun run check:licenses` fails when they no
  longer match `bun.lock`. A dependency whose license family has no reviewed notice text stops the
  run instead of being listed as if its obligations were known.
- A commit-time secret scan. `.githooks/pre-commit` runs the leak guard over the staged diff, then
  the static checks, and adds the license checks when `bun.lock` or `package.json` is staged.
  `bun install` points `core.hooksPath` at `.githooks/` and seeds the machine-local pattern file,
  so a fresh clone picks up the hook without a separate setup step.
- `bun run smoke:qc:fast` runs the static half of the quality gate without the test suite, and
  `bun run check:leak-guard` self-tests the guard against fixtures assembled at runtime.

### Changed

- `smoke:qc` now runs the fast static gate, the leak-guard self-test, the license checks, and then
  the tests.
- `@octokit/rest` is pinned to an exact version. The attribution documents are generated from the
  lockfile, so a floating range lets an install move the dependency closure away from what they
  describe.
- Prettier writes trailing commas in every position, which reformatted the source, scripts, and
  tests. No behavior changed.
- The README Scripts table lists the license and leak-guard commands, and the License section
  explains what the two attribution documents cover, why neither ships inside the published
  tarball, and why they still matter to anyone distributing the `compile` executable.

### Fixed

- The screenshot push guard no longer fails a version-tag push in a repository that never captures
  screenshots. A missing `screenshots/` directory now means the repository does not capture at all;
  once the directory exists, a tag with no capture under it still fails.

## [2.1.0] - 2026-08-03

### Added

- StarSync runs under Node 24 or newer as well as Bun. `npx starsync sync <path>` works on a machine
  that has never installed Bun, and root help lists the `npx` and `bunx` forms alongside the others.
- The build emits TypeScript declarations next to the bundles, so `import { syncArchive } from
'starsync'` is typed for consumers that never see the source.

### Changed

- The package is published to npm rather than held private. `bin`, `main`, `module`, and `types`
  resolve into `dist/`, and the tarball carries only the built entry points, the declarations, the
  README, and the license.
- The Bun-only install guard moved from `preinstall` to `prepare`. It still rejects npm, yarn, and
  pnpm for anyone working on the repository, and it no longer fires for anyone installing the
  published package, which is what killed `npx starsync` before it reached the CLI. `prepare` also
  builds, so a fresh clone or a Git dependency has working entry points.
- `engines` declares `node >=24.0.0` next to the existing Bun floor.
- Rename application and sync planning share one archive and checkout inventory instead of
  rescanning, and modification guards read the exact archive config without spawning Git.

### Fixed

- A case-only rename publishes through a temporary intermediate path, so `Owner` to `owner`
  completes on a case-insensitive filesystem. Existence checks that decide whether a destination is
  occupied now compare exact casing instead of trusting the filesystem's own answer.
- `verify --force` recovers a checkout that was renamed upstream and also has local changes.
  Replacements resolve by stable repository ID, keep the source and canonical destination distinct,
  and refuse duplicate identities or occupied destinations.
- Checkout discovery and planning ignore StarSync's own staging and damaged-backup directories.
  `verify --force` clears abandoned ones under the archive lock instead of treating them as archive
  members.
- A blocked checkout keeps its existing label and metadata. Labels are reconciled only after a
  current or updated outcome.
- Checkout label changes are atomic. Metadata is snapshotted and verified, restored when a later
  step fails, and a folder move is compensated rather than left pointing at an occupied path.

### Security

- Report strings, progress lines, diagnostics, and unexpected errors are sanitized before they are
  written, so a token passed as a command-line argument cannot reach human or JSON output.
- Redaction covers authorization headers, bearer tokens, generic key and value credential shapes,
  and provider-specific credential forms in addition to GitHub personal access tokens.

## [2.0.0] - 2026-08-02

### Added

- Added `rename` and `renameArchive` for read-only rename previews and explicitly applied updates
  after repository renames or ownership transfers.
- Added schema-version-2 JSON reporting with a current-format `rename` preview classified as
  `blocked`, `current`, `failed`, or `pending`.

### Changed

- StarSync now accepts only exact format-2 archive configuration with a valid owner, and every
  checkout must already carry a stable repository ID matching GitHub's resolved identity.
- CLI use now requires one of `sync`, `verify`, `rename`, `dates`, `init`, or `unlock`; bare
  invocation is a usage error with exit code 2.

### Fixed

- Uninitialized-archive errors now distinguish empty directories that can be initialized from
  populated pre-2.0 archives that must be preserved or moved aside before rebuilding.
- `verify --force` can recover a canonical checkout with missing identity only by publishing a
  fully validated replacement; it never writes identity into the existing checkout.
- Rename reports no longer retain a stale planned outcome after an update succeeds, and GitHub
  origin parsing rejects credentials, non-GitHub hosts, malformed paths, queries, and fragments.

### Removed

- Removed configless and older-format archive support, identity backfill, resumable conversion
  state, archive finalization, and every conversion-only implementation and interface.
- Removed the retired command, bare sync alias, deprecated programmatic exports, and schema-1
  checkout report shape.

## [1.5.0] - 2026-08-01

### Added

- Sync reports the tags it kept at their archived target. A refresh that succeeds or finds the
  checkout already current now carries a `remote-tags-retained` warning naming up to ten of them,
  so a moved upstream tag is visible without reading Git output.
- A repository whose Git LFS objects the server no longer provides is archived with its LFS
  pointer files instead of failing. StarSync retries the failed clone or refresh once with
  `GIT_LFS_SKIP_SMUDGE=1` and never writes that setting into the checkout.

### Changed

- Paths the platform cannot represent are now kept out of the working tree with a sparse checkout
  instead of `skip-worktree` bits. Sparse patterns survive a later fast-forward; the bits did not,
  so the next refresh tried to write the path again and failed. Either way the path itself stays
  in Git history and the index. ADR 0009 records the decision.

### Fixed

- A repository whose upstream moved a tag the archive already stores now refreshes instead of
  failing. Git exits non-zero on a rejected tag update even when every branch has already
  advanced, which left the checkout behind. StarSync keeps the archived tag target and finishes
  the refresh.
- A repository containing a path Windows cannot represent (one holding `: | < > " ? *`, a control
  character, a reserved device name, or a trailing space or period) is cloned and refreshed
  instead of failing.
- A checkout holding such a path is no longer reported as blocked by `sync`, `verify`, or
  `migrate`. Git reports it as a staged deletion that can never be resolved, which the guard
  against overwriting local work read as uncommitted work. Sync now excludes the path before
  deciding, and verify and migrate discount it without changing the checkout they inspect. All
  three still block on genuine local changes.
- An explicitly supplied empty or quoted-empty target path is now the documented usage error with
  exit code 2. It previously fell through to an implicit `starred_repos` directory beside the
  package, so a command could inspect or modify an archive the caller never named.

### Removed

- The pre-push screenshot artifact guard. It did not apply to this repository, so the hook no
  longer scans tracked or staged files for screenshots.

## [1.4.1] - 2026-07-28

### Fixed

- Sync now reports each repository as soon as it finishes and prints a status heartbeat every 30
  seconds while slow Git operations are still running. The final human report keeps failures,
  skips, warnings, and totals without repeating every successful checkout.

## [1.4.0] - 2026-07-28

### Added

- Added `verify --force` for owner-authorized recovery of managed archives. StarSync replaces
  checkouts that fail Git integrity checks or contain any local changes, but only after a fresh
  staged clone passes origin, identity, owner, cleanliness, and full object validation. Failed
  replacements leave the original checkout in place.
- Added recovery for repositories whose tracked paths cannot be materialized on Windows. StarSync
  retains the complete Git object database and `HEAD`, checks out every portable path, and marks
  NTFS-incompatible paths as `skip-worktree` so the managed checkout remains clean.

### Changed

- Synchronization now follows the repository's current GitHub default branch and continues
  processing valid repositories when another managed checkout cannot be inspected.
- Release validation now runs bounded Windows, macOS, and Linux jobs with superseded runs
  cancelled and third-party actions pinned to immutable commits.
- The pre-push hook now rejects tracked or staged screenshot artifacts before they can enter the
  repository.

### Security

- Git subprocesses now receive an allowlisted environment instead of inheriting unrelated parent
  secrets.

## [1.3.0] - 2026-07-23

### Added

- Added release validation on Windows, macOS, and Linux. The automated gate runs the locked Bun
  install, quality checks, bundle build, platform compilation, and an offline copied-archive
  journey. An opt-in live smoke can verify an explicit temporary archive copy without touching the
  configured archive.
- Added staged checkout publication. New managed repositories are cloned into unique
  StarSync-owned sibling directories, checked for GitHub.com origin, Git object integrity,
  archive-owner scope, and stable identity, then atomically renamed to their canonical folder.
  Failed attempts remove only their owned staging directory, preserve occupied destinations, and
  retain the bounded retry and credential-redaction contract.
- Added managed Archive Dates. StarSync now calculates the newest committer time reachable from
  every local Git reference, previews or repairs recognized checkout folder timestamps through
  `starsync dates`, and aligns timestamps after successful additions and refreshes. Timestamp
  failures preserve the successful Git outcome, add an error finding, and make sync exit 1.
- Added stable repository identity for every managed checkout. New repositories use
  `repository--owner` folders and store `starsync.repository-id` plus
  `starsync.repository-slug` in checkout-local Git configuration.
- Added resumable `migrate --apply`. It preserves successful identity writes and safe renames
  across checkout failures, adopts dirty checkouts without moving their work, and finalizes the
  archive format only after every checkout identity is recorded.
- Added one archive-wide operation lock for initialization, synchronization and dry runs,
  verification, migration preview, and date normalization. Locks identify their host, process,
  command, and start time; confirmed-dead same-host locks recover automatically, while remote or
  uncertain locks require a risk-reported `unlock --force`.

### Changed

- Synchronization now matches checkouts by stable GitHub repository ID instead of mutable slug or
  short folder name. Slug changes remain attached to the same checkout and are reported as pending
  renames until an explicit migration applies them.
- Removed the deprecated standalone `set-folder-dates` script and package alias; Archive Date
  management is available through the unified `dates` command and `normalizeArchiveDates` API.

## [1.2.0] - 2026-07-23

### Added

- StarSync now provides explicit `sync`, `verify`, `migrate`, `dates`, `init`, and `unlock`
  subcommands, including command-specific help and a read-only `sync --dry-run` mode. The
  unimplemented mutation commands return a defined unavailable response during the 1.x transition.
- Added fully local, read-only archive verification for Git integrity, repository identity,
  origins, duplicate checkouts, blocked state, and pending renames.
- Added a read-only migration preview for legacy archives. It resolves stable repository
  identities, proposes `repository--owner` folder names, and reports blocked, unsafe, duplicate,
  or conflicting checkouts without changing the archive.
- Every subcommand now supports `--json` with one schema-versioned report, separate checkout
  lifecycle and run outcome fields, severity-classified findings, predictable exit codes, and
  partial results after a first interruption.
- Added a Bun-only programmatic API for sync, verification, migration preview, date normalization,
  and initialization operations, with progress callbacks and `AbortSignal` cancellation.
- Added the full MIT license text declared by the package.

### Changed

- Sync now processes up to four repositories at once by default, preserves dirty or divergent
  checkouts, retains repositories that are no longer starred, and retries only transient API or Git
  transport failures.
- Legacy and incompatible managed archives are protected from `sync` and `dates` mutations until
  their supported migration path ships.

### Security

- GitHub API tokens are now separate from Git transport credentials. Git runs non-interactively,
  repository origins are restricted to GitHub.com, and credentials or token patterns are removed
  from reported URLs and errors.

## [1.1.1] - 2026-07-14

### Fixed

- Remote checks now accept cosmetic URL differences such as owner casing, a missing `.git`
  suffix, or trailing slashes. Repositories with genuinely different owners or names are still
  skipped.
- Existing clones are now found on case-insensitive filesystems even when the folder and GitHub
  repository use different capitalization. This prevents StarSync from trying to clone over the
  existing directory.

## [1.1.0] - 2026-06-11

### Added

- `--help` / `-h` flag for both `index.ts` and `scripts/set-folder-dates.ts`. Unknown arguments now exit 2 with usage text.
- `index.ts` now accepts a positional target-path argument that overrides `TARGET_PATH`.
- Per-repo success/failure summary at end of sync run.

### Changed

- All `git` subprocesses migrated from `execSync` (string interpolation) to `execFileSync` (argv array). Eliminates shell metacharacter handling in repo names and clone URLs.
- Default target path is now consistently `<repo>/starred_repos` for both scripts (previously `index.ts` used `process.cwd()/starred_repos`, `set-folder-dates.ts` used `<repo>/starred_repos`).
- `TARGET_PATH` env-var parsing is unified across both scripts: trim + strip surrounding quotes.
- `GITHUB_TOKEN` is now loaded via Bun's native `.env` support; the `dotenv` dependency was removed entirely. The missing-token error message is now `GITHUB_TOKEN is not set`.
- Error messages use the consistent `(error as Error).message` form.
- `formatTable` is properly typed with generics; no more `any[]`.
- `cloneOrPull` now verifies remote origin URL before pulling — prevents misidentifying repos with identical names from different owners.

### Fixed

- `index.ts` no longer exits 0 when the GitHub fetch fails. Both fetch failures and per-repo clone/pull failures now propagate to a non-zero exit code so cron jobs can detect failures.
- `set-folder-dates.ts` accepts only the canonical `--dry-run` spelling; the `--dryrun` and `-dryrun` aliases were removed.
- `set-folder-dates.ts` no longer silently skips a folder when `git log` or `fs.utimesSync` fails — it now prints a warning with the folder name and the underlying error before marking it skipped.
- Deduplicated `.gitattributes` so each file pattern appears exactly once, organized into text and binary sections.

### Removed

- Unused `prettier-plugin-tailwindcss` dev dependency (this CLI tool has no frontend or Tailwind usage).

### Security

- Subprocess argv arrays prevent shell injection via folder names returned from `fs.readdirSync` (a folder named `; rm -rf ~ #` could previously have been interpreted by the shell in `set-folder-dates.ts`).

## [1.0.0]

- Initial commit.
