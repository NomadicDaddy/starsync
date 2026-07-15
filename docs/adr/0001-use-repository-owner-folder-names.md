# Use repository-owner folder names

Managed checkout folders use `<repository>--<owner>`, derived from the repository's current `owner/name` slug. The repository's GitHub-assigned ID remains its identity when its slug changes. This keeps the archive flat and collision-free while preserving repository-first alphabetical browsing and top-level folder timestamp management. Owner-first names and nested owner directories were rejected because they make repositories harder to browse by project name, while short repository names alone are not unique.

Existing short-name folders are migrated through a separate, preview-first operation rather than during normal synchronization. The operation reports proposed renames and conflicts without changing the archive unless the user explicitly applies it. Until migration, synchronization identifies legacy folders through their repository identity and refreshes them in place.

A repository rename or ownership transfer creates a pending rename because its slug-based folder label is no longer current. Normal synchronization reports the pending rename but continues refreshing the existing checkout. The explicit migration operation renames the folder and updates its remote URL only when the user applies the preview.

Migration may record identity for a dirty checkout or one whose local state cannot be verified, but it does not rename that folder. The checkout remains blocked with a pending rename until a later explicit migration can move it safely. These deferred folder renames do not prevent the archive format migration from completing once every checkout has a reliable identity.
