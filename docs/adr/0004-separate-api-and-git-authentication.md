# Separate API and Git authentication

StarSync uses `GITHUB_TOKEN` only for GitHub API operations. Initialization authenticates and records the Archive Owner; synchronization authenticates that owner and discovers current Starred Repositories; rename resolves repositories and, on apply, authenticates the owner; and forced verification authenticates the owner and resolves repositories needed for replacement. Local verification, date normalization, and unlocking do not require the token.

Clone and fetch operations use independently configured system Git credentials, such as Git Credential Manager or SSH, and never receive the API token. StarSync does not place the token in remote URLs, command arguments, or repository configuration. This requires unattended environments to configure Git access separately, but avoids spreading one sensitive token into subprocesses and Managed Checkouts.

All human output, JSON results, and persisted operational state redact credentials from URLs and Git errors. Verification treats a credential-bearing remote URL as an error because managed checkouts must rely on external Git authentication rather than embedded secrets.
