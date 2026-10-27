# Use repository-owner folder names

Managed checkout folders use `<repository>--<owner>`, derived from the repository's current `owner/name` slug. The repository's host-assigned ID remains its identity when its slug changes, scoped to the archive's GitHub or Codeberg host. The folder names keep the archive flat and distinguish same-named repositories with different owners. They also preserve alphabetical browsing by repository name and top-level folder timestamp management.

Owner-first names and nested owner directories were rejected because they make repositories harder to browse by project name. Short repository names alone are not unique.

The separate, preview-first `rename` operation changes folder labels. Normal synchronization leaves them in place. Every checkout must already contain a stable repository ID matching the selected host's resolved ID. Preview reports proposed renames and conflicts without changing checkout content. It still acquires and releases transient archive operation-lock metadata.

A repository rename or ownership transfer creates a pending rename because its slug-based folder label is no longer current. Normal synchronization reports the pending rename but continues refreshing the existing checkout, updating its stored slug and origin URL after a successful refresh. Explicit `rename --apply` runs its own preview, moves safe folders, and brings the stored slug and origin URL up to date where needed; a separate earlier preview invocation is not required.

A dirty or unverifiable checkout remains blocked with a pending rename. Rename never creates or repairs identity metadata, never overwrites an occupied destination, and preserves successful checkout updates if a later checkout fails.
