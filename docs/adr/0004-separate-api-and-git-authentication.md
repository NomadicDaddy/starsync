# Separate API and Git authentication

StarSync uses its GitHub API credential only to discover the user's current starred repositories. Clone and refresh operations use authentication already configured for Git, such as Git Credential Manager or SSH. StarSync does not place the API token in remote URLs, command arguments, or repository configuration. This requires unattended environments to configure Git access separately, but avoids spreading one sensitive token into subprocesses and managed checkouts.

All human output, JSON results, and persisted operational state redact credentials from URLs and Git errors. Verification treats a credential-bearing remote URL as an error because managed checkouts must rely on external Git authentication rather than embedded secrets.
