# Exclude paths the host filesystem cannot represent

Some repositories publish paths that a host filesystem cannot create. On Windows these include `: | < > " ? *`, control characters, reserved device names such as `nul`, and components ending in a space or a period. Git refuses to check such a path out, which would otherwise fail the clone of an entire repository over a single file.

StarSync keeps those paths in Git history and in the index, and excludes only the working-tree copy. The exclusion is recorded in sparse checkout patterns rather than relying on manually set `skip-worktree` bits alone. Git uses those patterns to maintain the index's `skip-worktree` state across later fast-forwards, keeping the unrepresentable paths excluded. Applying the exclusion requires disabling Git's NTFS path guard for the invocations that read the tree, paired with sparse patterns that keep those paths out of the working tree.

Without this, a checkout containing such a path can report a deletion that cannot be resolved by materializing the file. StarSync's guard against overwriting local work would read that as uncommitted work and block the checkout on every future refresh. When all reported paths are unrepresentable, refresh applies sparse exclusions and checks status again before advancing. Read-only verification and rename previews tolerate status consisting entirely of unrepresentable paths without changing the checkout. Any representable local change still blocks refresh or a pending rename and is reported as an error by verification.

Rewriting the path to a representable name was rejected because the archived checkout would no longer match the repository. Skipping such repositories entirely was rejected because their history is exactly what the archive exists to preserve.
