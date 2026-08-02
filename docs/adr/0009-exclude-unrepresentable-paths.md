# Exclude paths the host filesystem cannot represent

Some repositories publish paths that a host filesystem cannot create. On Windows these include `: | < > " ? *`, control characters, reserved device names such as `nul`, and components ending in a space or a period. Git refuses to check such a path out, which would otherwise fail the clone of an entire repository over a single file.

StarSync keeps those paths in Git history and in the index, and excludes only the working-tree copy. The exclusion is recorded as a sparse checkout entry rather than a `skip-worktree` bit, because a later fast-forward re-reads sparse patterns while it discards `skip-worktree` state and would try to write the unrepresentable path again. Writing the exclusion requires disabling Git's NTFS path guard for the invocations that read the tree, which is safe only because the sparse pattern already keeps the path out of the working tree.

Without this, a checkout containing such a path reports a staged deletion that can never be resolved. StarSync's guard against overwriting local work would read that as uncommitted work and block the checkout on every future refresh. The guard now excludes unrepresentable paths before deciding, so it blocks only on state a user could actually have created.

Rewriting the path to a representable name was rejected because the archived checkout would no longer match the repository. Skipping such repositories entirely was rejected because their history is exactly what the archive exists to preserve.
