# TODO List — StarSync

## Technical Debt

- [ ] `bun` not available in CI/agent environment — `smoke:qc` and `bun test` cannot be verified remotely

## From Codebase Analysis (2026-06-11)

- [ ] **H1** Add `normalizeRepoUrl` unit tests — edge cases: case-insensitivity, `.git` suffix, trailing slashes, SSH URLs, Unicode
- [ ] **H2** Fix `.gitignore` duplicate entries — `.claude/` (line 8) and `dist/` (line 24) appear twice
- [ ] **H3** Update `project-profile.json` — remove `dotenv ^17.4.2` from `keyDependencies` (removed in v1.1.0)
- [ ] **M1** Parallel clone/pull with controlled concurrency — `Promise.allSettled` + semaphore, `--concurrency` flag
- [ ] **M2** Consistent error handling — use `getErrorMessage` helper instead of `(err as Error).message` everywhere
- [ ] **M3** Remove redundant `.prettierignore` — Prettier auto-reads `.gitignore`
- [ ] **M4** Add `LICENSE` file — MIT, matching `package.json` license field
- [ ] **M5** Add progress counter during sync — "Syncing 12/247..." before each repo
