# Preserve remote history

A refresh fetches all configured remote branches and tags without pruning references that have disappeared upstream. StarSync accepts higher disk use and stale remote references because preserving repositories is its primary purpose, and deleted history may be impossible to recover after pruning and garbage collection. Refreshing only the checked-out branch was rejected because it leaves much of a repository's published history outside the archive.

After fetching, StarSync leaves the managed checkout on the repository's current GitHub default branch and advances it only by fast-forward. It follows a renamed default branch when the checkout has no unexpected local state. A divergent branch or unpushed commit blocks the refresh rather than triggering a reset, merge, or rebase.
