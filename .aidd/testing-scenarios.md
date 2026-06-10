# Testing Scenarios — StarSync

StarSync is a Bun/TypeScript CLI tool that synchronizes all starred GitHub repositories to the local filesystem — cloning new repos and pulling existing ones — with a companion script for normalizing folder timestamps to match each repo's latest commit date.

## Scenarios

1. `spernakit-tester starsync: I want to verify that running bun run sync with a valid GITHUB_TOKEN clones all my starred repos into the default starred_repos directory and exits with code 0`
2. `spernakit-tester starsync: I want to verify that running bun run sync a second time pulls existing repos instead of re-cloning them, and that the summary reports zero failures`
3. `spernakit-tester starsync: I want to verify that passing a custom target-path as a positional argument overrides both TARGET_PATH env var and the default starred_repos directory`
4. `spernakit-tester starsync: I want to verify that running bun run sync without a GITHUB_TOKEN in .env prints an error message and exits with code 1`
5. `spernakit-tester starsync: I want to verify that running bun run set-folder-dates updates each repo folder's mtime to match its latest git commit date and displays the oldest/newest timestamp tables`
6. `spernakit-tester starsync: I want to verify that running bun run set-folder-dates -- --dry-run shows would-update entries and oldest/newest tables without actually modifying any folder timestamps`
7. `spernakit-tester starsync: I want to verify that bun run build produces a bundled output in dist/ and bun run compile produces a standalone binary that successfully runs the sync`
8. `spernakit-tester starsync: I want to verify that unknown CLI flags like --verbose produce an error message with usage text and exit with code 2`
9. `spernakit-tester starsync: I want to verify that bun run smoke:qc runs typecheck, lint, and format:check in sequence and passes with a clean exit`
10. `spernakit-tester starsync: I want to verify that a target directory containing non-git folders alongside git repos is handled correctly — sync skips the non-git folders, and set-folder-dates reports them as skipped:not-git`
11. `spernakit-tester starsync: I want to verify that running bun run sync --help or bun run sync -h prints the help text including usage, options, and environment variable documentation, and exits with code 0`
12. `spernakit-tester starsync: I want to verify that setting only TARGET_PATH in .env (with no positional argument) causes sync to resolve the target directory from that env var, cloning repos into the specified path`
13. `spernakit-tester starsync: I want to verify that running set-folder-dates with a target-path that does not exist on disk prints an error message about the missing root path and exits with code 1`
14. `spernakit-tester starsync: I want to verify that running bun run sync with an expired or invalid GITHUB_TOKEN produces an authentication error from the GitHub API and exits with code 1`
15. `spernakit-tester starsync: I want to verify that bun test executes all unit tests in test/index.test.ts — covering parseArgs, resolveTargetPath, listFolders, and stripQuotes — and reports all passing`
16. `spernakit-tester starsync: I want to verify that when one repo fails to clone while others succeed during bun run sync, the tool still processes all remaining repos, prints the "Failed repositories" list with the failing repo name and error message, and exits with code 1`
17. `spernakit-tester starsync: I want to verify that when my GitHub account has more than 100 starred repos, bun run sync paginates through all pages via Octokit and successfully clones every repo — confirming the final succeeded count matches the actual number of starred repos`
18. `spernakit-tester starsync: I want to verify that when my GitHub account has zero starred repos, bun run sync fetches an empty list, prints "Succeeded: 0. Failed: 0." with no errors, and exits with code 0`
19. `spernakit-tester starsync: I want to verify a full end-to-end workflow — run bun run sync to clone starred repos into a fresh temp directory, then run bun run set-folder-dates with that same directory to update mtimes, confirming both commands exit with code 0 and the folder timestamps match their latest git commit dates`
20. `spernakit-tester starsync: I want to verify that running bun run set-folder-dates -- --help prints the set-folder-dates help text including usage, --dry-run option, and TARGET_PATH documentation, then exits with code 0`

---

## Post-Test Procedure

- Run the native `bug2feature` ingredient for starsync
- delete the ingested bugs from bugs.json files (delete them if only placeholder or tests remain)
- Run the native `feature-review` ingredient for starsync
- iterate through remediation features created, resolving all issues and ensuring fixes applied intelligently to template as applicable
- delete remediation features resolved
- create session report (include time taken for each step among details)
