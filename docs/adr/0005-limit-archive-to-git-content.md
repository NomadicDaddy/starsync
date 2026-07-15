# Limit the archive to Git content

The managed archive preserves Git history and a usable checkout of each repository's default branch. StarSync does not exhaustively fetch Git LFS objects or recursively synchronize submodule contents. Complete dependency preservation was rejected because it can introduce unbounded storage, additional credentials, and failures in repositories outside the user's starred collection. As a result, the archive is not a complete backup of content stored outside the repository's ordinary Git object database.

StarSync also excludes GitHub-hosted material outside the primary repository, including issues, pull-request discussion, release assets, wiki content, and workflow artifacts. Exporting those resources would turn the tool into a GitHub account backup system with separate data models, retention rules, and API limits.
