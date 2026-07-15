# StarSync

StarSync maintains a local archive of repositories selected through a user's GitHub stars. The archive is intended for preservation and browsing, not active development.

## Language

**Starred Repository**:
A public or private GitHub.com repository selected by the user with a star and eligible for inclusion in the archive.

**Repository Identity**:
The stable identifier assigned by GitHub.com that continues to identify a repository when its name or owner changes.
_Avoid_: Repository slug, repository name, folder name

**Repository Slug**:
The current human-readable `owner/name` pair for a GitHub repository.
_Avoid_: Repository identity

**Managed Archive**:
The local collection of primary Git repository histories and usable checkouts that StarSync preserves and refreshes, excluding externally stored content and GitHub-hosted metadata.
_Avoid_: Mirror, backup

**Archive Owner**:
The GitHub.com account whose current stars determine which checkouts are active in a **Managed Archive**.
_Avoid_: Token owner, filesystem owner

**Initialized Archive**:
A **Managed Archive** whose owner and archive format have been recorded before other operations may use it.
_Avoid_: Target directory, repository folder

**Legacy Archive**:
A configless collection of GitHub.com checkouts recognized during the 1.2 transition for verification and migration preview only.
_Avoid_: Initialized Archive, arbitrary directory

**Managed Checkout**:
A usable local copy of a repository whose updates are controlled by StarSync and which is not an active development workspace.
_Avoid_: Working copy, worktree

**Active Checkout**:
A **Managed Checkout** whose repository is currently starred and eligible for refresh.
_Avoid_: Current checkout, updated checkout

**Retained Checkout**:
A **Managed Checkout** kept in the archive without refresh because its repository is not currently starred.
_Avoid_: Deleted repository, stale checkout

**Blocked Checkout**:
A **Managed Checkout** that StarSync retains but cannot safely refresh because it contains unexpected local state.
_Avoid_: Failed repository, broken checkout

**Pending Rename**:
A **Managed Checkout** whose folder label no longer matches the repository's current slug and awaits an explicitly approved rename.
_Avoid_: Identity change, new repository

**Archive Date**:
The newest Git committer time reachable from any locally stored reference in a **Managed Checkout**.
_Avoid_: Sync time, folder modification time

**Refresh**:
Update a **Managed Checkout** with available remote branches and tags without pruning retained history or rewriting local state.
_Avoid_: Pull

**Verify**:
Inspect a **Managed Archive** for Git integrity and identity or lifecycle inconsistencies without changing it.
_Avoid_: Synchronize, repair

**Sync Outcome**:
The result of one synchronization attempt for a checkout: added, updated, current, skipped, or failed.
_Avoid_: Checkout state, status

**Synchronize**:
Add missing **Starred Repositories** to the **Managed Archive**, refresh their **Managed Checkouts**, and retain repositories that are no longer starred.
_Avoid_: Mirror

## Relationships

- A **Managed Archive** contains zero or more **Managed Checkouts**
- A **Managed Archive** belongs to exactly one **Archive Owner**
- A **Managed Archive** becomes an **Initialized Archive** before synchronization, verification, or date normalization
- A **Legacy Archive** may be inspected by StarSync 1.2 but does not become an **Initialized Archive** until 2.0 migration is explicitly applied
- An **Archive Owner** may have one or more separate **Managed Archives**
- Each **Starred Repository** has exactly one **Repository Identity** and one current **Repository Slug**
- A **Starred Repository** has at most one **Managed Checkout** in a **Managed Archive**
- Each **Managed Checkout** corresponds to exactly one **Repository Identity**
- A repository rename or ownership transfer changes its **Repository Slug** without changing its **Repository Identity**
- A **Managed Checkout** may remain in the **Managed Archive** after its repository is unstarred or becomes unavailable
- A changed **Repository Slug** gives its **Managed Checkout** a **Pending Rename** without blocking refresh
- A currently starred repository has an **Active Checkout** after it has been added to the archive
- An unstarred repository's **Managed Checkout** becomes a **Retained Checkout**
- A **Retained Checkout** becomes refreshable again when its repository is starred again
- A **Refresh** preserves available branches, tags, and previously retained history in a **Managed Checkout**
- A **Managed Checkout** with at least one commit has one **Archive Date**
- Adding or successfully refreshing a **Managed Checkout** aligns its folder timestamp with its **Archive Date**
- A successful **Refresh** leaves the **Managed Checkout** on the repository's current default branch
- A **Managed Checkout** becomes a **Blocked Checkout** when refreshing it would overwrite or rewrite local state
- A **Blocked Checkout** remains in the **Managed Archive** while other checkouts continue to synchronize
- Each attempted checkout action has one **Sync Outcome** independent of the checkout's lifecycle state and **Pending Rename** flag
- **Verify** may report a **Blocked Checkout** or **Pending Rename** but never refresh, rename, or repair a checkout

## Example dialogue

> **Dev:** "Should **Synchronize** remove a **Managed Checkout** when its repository is no longer starred?"
> **Domain expert:** "No. It becomes a **Retained Checkout**, so it remains available for browsing without further refreshes."
>
> **Dev:** "What happens when a **Managed Checkout** contains local work?"
> **Domain expert:** "It becomes a **Blocked Checkout** and is retained without being refreshed."
>
> **Dev:** "Does an ownership transfer create another **Managed Checkout**?"
> **Domain expert:** "No. Its **Repository Identity** is unchanged, so the existing checkout gets a **Pending Rename**."

## Flagged ambiguities

- "sync" previously suggested an exact mirror of the current starred list. It is additive: missing repositories are added, existing managed checkouts are refreshed, and absent repositories are retained.
- "local copy" could mean either a **Managed Checkout** or an active development workspace. StarSync manages only the former.
- A repository's slug, short name, and local folder name are not its identity. **Repository Identity** means the stable identifier assigned by GitHub; **Repository Slug** means the current `owner/name` pair.
- The **Archive Owner** is identified by the GitHub account itself, not by whichever token or login name happens to be used later.
- An existing repository directory is not an **Initialized Archive** until StarSync records its owner and archive format.
- A configless directory is a **Legacy Archive** only when StarSync 1.2 recognizes GitHub.com checkouts in it; empty or unrelated directories remain uninitialized.
- A blocked refresh does not mean the repository is unavailable or corrupt. It means StarSync found local state that it will not rewrite automatically.
- A **Pending Rename** is a label mismatch, not a new repository or a refresh failure.
- "status" previously mixed persistent checkout state with the result of one run. Canonical reports separate lifecycle state, **Pending Rename**, and **Sync Outcome**.
- A **Retained Checkout** is dormant, not deleted or damaged; starring its repository again resumes refreshes.
- An **Archive Date** reflects repository history across all local references, not when StarSync last ran or which branch is checked out.
- **Archive Date** uses committer time rather than author time so it represents when that exact commit entered repository history.
- **Verify** is read-only; any resulting migration or repair is a separate, explicitly approved action.
- "archive" means the primary Git repository and a usable checkout, not a complete backup of LFS objects, submodules, issues, discussions, release assets, wikis, or workflow artifacts.
- StarSync 2.0 manages GitHub.com repositories only; repositories hosted on GitHub Enterprise Server or other Git services are outside its context.
- Repository visibility does not change archive membership; private repositories require Git credentials outside StarSync.
- "pull" described the previous update mechanism but not the preservation contract. The canonical verb is **Refresh**.
