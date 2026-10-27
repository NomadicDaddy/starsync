# Bind archives to one forge host

Accepted 2026-10-06. This extends the GitHub-only scope in ADRs 0003 and 0007 to include Codeberg.

Each archive belongs to one host and one account on that host. `init --host codeberg.org` selects
Codeberg; omitted `--host` selects GitHub. Format 2 gains a defined optional `host` field accepting
only `github.com` or `codeberg.org`. Absence means GitHub, as all existing format-2 archives were
GitHub archives. New archives write the field explicitly. Unknown fields and hosts remain errors.
This adds host selection without a conversion path, format migration or rewrite of existing data.

Numeric repository and account IDs are meaningful only within a host. An archive must never mix
hosts or be moved to another host by editing its config. Origin validation, owner authentication,
stars, rename lookup, repair and metadata transitions use the selected host. Rename resolves the
stored numeric ID so a removed or reused old slug cannot redirect identity.

GitHub uses Octokit; Codeberg uses its fixed HTTPS Forgejo API with response validation, bounded
request timeouts and retry handling. Codeberg stars are paged until an empty page; a short page
alone is not exhaustion because servers can cap page sizes. Repeated IDs fail rather than looping or
silently declaring the archive complete. Codeberg API redirects are rejected to keep credentials on
host. GitHub star pagination uses Octokit's paginator.

`GITHUB_TOKEN` and `CODEBERG_TOKEN` are selected by the CLI from the archive host. Programmatic
callers pass the matching token explicitly. Git authentication remains separate. Clone and fetch
never receive the API token, and config never stores it. Arbitrary Forgejo hosts remain out of scope.
