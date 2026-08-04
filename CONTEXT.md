# StarSync

StarSync maintains a local archive of repositories selected through one user's GitHub stars. The
archive is intended for preservation and browsing, not active development.

## Language

**Starred Repository**:
A public or private GitHub.com repository selected by the archive owner and eligible for inclusion.

**Repository Identity**:
The stable numeric ID assigned by GitHub.com. It remains unchanged when the repository name or
owner changes.
_Avoid_: Repository slug, repository name, folder name

**Repository Slug**:
The current human-readable `owner/name` pair.
_Avoid_: Repository identity

**Managed Archive**:
A format-2 collection of primary Git histories and usable checkouts that StarSync preserves and
refreshes, excluding externally stored content and GitHub-hosted metadata.
_Avoid_: Mirror, backup, arbitrary directory

**Archive Owner**:
The GitHub.com account whose current stars determine active checkouts.
_Avoid_: Token owner, filesystem owner

**Initialized Archive**:
A **Managed Archive** with an exact `.starsync/config.json` recording format 2 and a valid
**Archive Owner**. A configless directory is uninitialized, regardless of its contents.
_Avoid_: Target directory, repository folder

**Managed Checkout**:
A usable local repository whose updates are controlled by StarSync, with a stable repository ID
and last-known slug in local Git configuration.
_Avoid_: Working copy, worktree

**Active Checkout**:
A **Managed Checkout** whose repository is currently starred and eligible for refresh.
_Avoid_: Current checkout, updated checkout

**Retained Checkout**:
A **Managed Checkout** kept without refresh because its repository is not currently starred.
_Avoid_: Deleted repository, stale checkout

**Blocked Checkout**:
A **Managed Checkout** StarSync retains but cannot safely refresh or rename because it contains
unexpected or unverifiable local state.
_Avoid_: Failed repository, broken checkout

**Pending Rename**:
A **Managed Checkout** whose stored slug, origin, or folder label differs from the repository's
current slug and awaits explicit rename application.
_Avoid_: Identity change, new repository

**Archive Date**:
The newest Git committer time reachable from any locally stored reference.
_Avoid_: Sync time, folder modification time

**Refresh**:
Update a **Managed Checkout** with available remote branches and tags without pruning retained
history or rewriting local state.
_Avoid_: Pull

**Verify**:
Inspect a **Managed Archive** for format, owner, Git integrity, identity, and lifecycle
inconsistencies without changing it.
_Avoid_: Synchronize, repair

**Rename**:
Resolve each **Managed Checkout** by its existing stable identity, preview current slug and folder
changes, and optionally apply safe slug, origin, and canonical-folder updates.
_Avoid_: Identity backfill, synchronize

**Sync Outcome**:
The result of one synchronization attempt: added, updated, current, skipped, or failed.
_Avoid_: Checkout state, status

**Synchronize**:
Add missing **Starred Repositories**, refresh active **Managed Checkouts**, and retain repositories
that are no longer starred.
_Avoid_: Mirror

## Relationships

- A **Managed Archive** contains zero or more **Managed Checkouts**.
- A **Managed Archive** belongs to exactly one **Archive Owner**.
- Format 2 is the only accepted archive format; every other format is unsupported.
- A configless or malformed directory is not a **Managed Archive** and its contents are not
  inspected for conversion.
- Each **Managed Checkout** has exactly one valid **Repository Identity** and one last-known
  **Repository Slug**.
- A **Starred Repository** has at most one **Managed Checkout** in an archive.
- Duplicate or missing checkout identities are errors.
- A rename or ownership transfer changes the **Repository Slug** without changing the
  **Repository Identity**.
- A changed slug produces a **Pending Rename** without blocking refresh.
- **Rename** requires the stored ID to match GitHub's resolved ID; it never creates identity.
- Rename preview is read-only. Rename application authenticates the **Archive Owner**.
- A dirty, unverifiable, duplicated, mismatched, or colliding checkout is not renamed.
- Successful rename updates remain when another checkout fails or processing is interrupted.
- **Synchronize** measures free space once at startup, after clearing abandoned owned artifacts,
  and refuses to begin repository work below the configured minimum; a preview reports the
  shortfall without refusing. The minimum is a starting reserve, not a guarantee that the run has
  room to finish.
- Forced verification takes the same reserve, since it clones replacements; read-only verification
  writes nothing and never measures.
- A currently starred repository has an **Active Checkout** after addition.
- An unstarred repository becomes a **Retained Checkout** and becomes active again if re-starred.
- A **Refresh** preserves available branches, tags, and previously retained history.
- A successful refresh leaves the checkout on the current default branch.
- A checkout becomes **Blocked** when refresh or rename would overwrite real local state.
- A path the host cannot represent is not local state; it remains in Git history and the index.
- Each attempted action has one outcome independent of lifecycle and pending-rename state.
- **Verify** never refreshes, renames, or repairs unless the caller explicitly selects `--force`.
- Forced verification may replace a missing-identity checkout only when its canonical folder
  resolves uniquely; it never writes identity into the existing checkout.
- A checkout with at least one commit has one **Archive Date**.

## Example dialogue

> **Dev:** "Should synchronization remove a checkout when its repository is no longer starred?"
> **Domain expert:** "No. It becomes retained and stays available for browsing."
>
> **Dev:** "Does an ownership transfer create another checkout?"
> **Domain expert:** "No. Its stable identity is unchanged, so the existing checkout gets a
> pending rename."
>
> **Dev:** "Can rename repair a checkout without identity metadata?"
> **Domain expert:** "No. Format-2 identity is required before any rename can be previewed or
> applied."

## Flagged ambiguities

- "Sync" is additive rather than an exact mirror: absent stars are retained.
- "Local copy" may mean a managed checkout or an active development workspace; StarSync manages
  only the former.
- Slug, short name, and folder name are labels, not identity.
- The owner is identified by stable GitHub account ID, not a token or mutable login.
- A repository directory is not initialized until exact format-2 owner configuration exists.
- A blocked action means StarSync found state it will not overwrite; it does not prove corruption.
- Pending rename is a label mismatch, not a refresh failure or new repository.
- Lifecycle, pending rename, and command outcome are separate reporting concepts.
- Archive Date is repository history time, not the time StarSync last ran.
- The archive covers primary Git data and a usable checkout, not all LFS objects, submodules,
  issues, discussions, release assets, wikis, or workflow artifacts.
- StarSync manages GitHub.com only; other Git hosts are outside its context.
