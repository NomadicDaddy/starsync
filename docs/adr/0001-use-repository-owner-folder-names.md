# Use repository-owner folder names

Managed checkout folders use `<repository>--<owner>`, derived from the repository's current `owner/name` slug. The repository's GitHub-assigned ID remains its identity when its slug changes. This keeps the archive flat and collision-free while preserving repository-first alphabetical browsing and top-level folder timestamp management. Owner-first names and nested owner directories were rejected because they make repositories harder to browse by project name, while short repository names alone are not unique.

Folder labels are changed through the separate, preview-first `rename` operation rather than during normal synchronization. Every checkout must already contain a stable repository ID matching GitHub's resolved ID. Preview reports proposed renames and conflicts without changing the archive.

A repository rename or ownership transfer creates a pending rename because its slug-based folder label is no longer current. Normal synchronization reports the pending rename but continues refreshing the existing checkout. Explicit `rename --apply` updates the stored slug and remote URL and moves the folder only after the preview proves the checkout safe.

A dirty or unverifiable checkout remains blocked with a pending rename. Rename never creates or repairs identity metadata, never overwrites an occupied destination, and preserves successful checkout updates if a later checkout fails.
