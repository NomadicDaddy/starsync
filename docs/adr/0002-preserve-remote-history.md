# Preserve remote history

A refresh fetches all configured remote branches and tags without pruning references that have disappeared upstream. StarSync accepts higher disk use and stale remote references because preserving repositories is its primary purpose, and deleted history may be impossible to recover after pruning and garbage collection. Refreshing only the checked-out branch was rejected because it leaves much of a repository's published history outside the archive.

A tag that upstream has moved to a different commit is fetched without force, so Git refuses the update and reports the fetch as failed even after every branch has advanced. StarSync keeps the archived tag target and treats the fetch as complete, because a moved tag usually means the published history it named was replaced, and that older history exists nowhere else once the archive follows the move. The refresh continues and reports the retained tags as a warning. A rejection of any other kind, or any fatal Git error in the same output, still fails the refresh.

After fetching, StarSync leaves the managed checkout on the repository's current GitHub default branch and advances it only by fast-forward. It follows a renamed default branch when the checkout has no unexpected local state. A divergent branch or unpushed commit blocks the refresh rather than triggering a reset, merge, or rebase.
