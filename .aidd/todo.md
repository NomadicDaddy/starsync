# TODO List — StarSync

## Medium Priority

- [ ] **Add cloneOrPull remote URL verification** — name-only matching can misidentify repos → `audit-logic-1781133983-cloneorpull-determines-repo-existence-by-name-match-but-doesn-t-verify-git-integ`
- [ ] **Add runStarsync test coverage** — main orchestrator function has zero test coverage → `audit-testing-1781133983-no-test-coverage-for-runstarsync-orchestration-function`

## Low Priority

- [ ] **Deduplicate `.gitattributes`** — multiple duplicate entries (`*.json`, `*.md`, `*.yml`, `*.yaml`, `*.zip`) → `audit-code-quality-1781133983-duplicate-entries-in-gitattributes`

## Technical Debt

- [ ] `bun` not available in CI/agent environment — `smoke:qc` and `bun test` cannot be verified remotely
