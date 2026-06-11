# Document Review: `.aidd/spec.md` — starsync

**Date:** 2026-07-27
**Document Reviewed:** `.aidd/spec.md`
**Result:** ❌ **Document does not exist**

---

## Summary

The document `.aidd/spec.md` was requested for review but **does not exist** in the repository. This is a required AIDD artifact that has been flagged as missing in every audit and review since 2026-06-10 (4 separate reports).

---

## Verification Against Reality

| Claim in Spec | Actual State | Status |
|---|---|---|
| *(no claims — file absent)* | N/A | ❌ MISSING |

---

## History of Missing-Flag Events

| Date | Report | Mention |
|---|---|---|
| 2026-06-10 | `.aidd/reports/intake.md` | "`.aidd/spec.md` — **Required** — not yet created" |
| 2026-06-10 | `.aidd/reports/feature-coverage-audit-2026-06-10.md` | "No `.aidd/spec.md` exists" → recommended creation |
| 2026-07-14 | `.aidd/reports/feature-coverage-audit-2026-07-14.md` | "No `.aidd/spec.md` exists. Feature JSON specs partially compensate but do not replace a formal project spec." → recommended creation |
| 2026-07-27 | *(this review)* | Confirmed still absent |

---

## Impact Assessment

### What Compensates for the Missing Spec

The project is not entirely undocumented. The following artifacts partially cover the spec's intended role:

1. **Feature JSONs (8 completed)** — Each has a `spec` field with verification statements. Cross-validated as accurate in 5 separate feature reviews.
2. **`.aidd/project-structure.md`** — Documents repo layout, key modules, technology stack, data model, API overview, and development workflow.
3. **`.aidd/project-profile.json`** — Structured stack, deployment, auth, data sensitivity, criticality, and validation details.
4. **`README.md`** — User-facing documentation: install, config, usage, scripts, scheduling.
5. **`.aidd/testing-scenarios.md`** — 20 end-to-end testing scenarios.

### What Is Missing Without the Spec

A formal `.aidd/spec.md` would serve as the **product specification source of truth**. The gap means:

1. **No single document defines the product contract.** The product description is fragmented across README.md, project-structure.md, project-profile.json, and feature JSONs.
2. **No authoritative spec for audit references.** Multiple audit definitions (ARCHITECTURE, LOGIC, FRONTEND, DOCUMENTATION) reference `spec.md` as a source of truth. Each currently has nothing to resolve against.
3. **No invariant-enforcement anchor.** The ASSERTIONS audit explicitly calls spec.md "product specification (source of contextual invariant language)" — it cannot enforce spec-level invariants without it.
4. **Backlog feature prioritization lacks product context.** The 10 backlog items were triaged during audit-finding reviews but without a formal product spec to measure importance against.

### Risk Assessment

- **Current risk:** LOW — starsync is a stable, complete CLI tool with no active feature development. All 8 features are completed and verified. The backlog consists of housekeeping and nice-to-haves.
- **Future risk:** MEDIUM — if new features are added or backlog items are remediated, the absence of a formal spec increases the chance of scope creep, inconsistent decisions, and audit false positives.

---

## Recommended Content for `.aidd/spec.md`

Based on the current codebase state, the spec should document:

### 1. Product Definition
- starsync is a Bun/TypeScript CLI that synchronizes all starred GitHub repositories to the local filesystem
- Clone new repos, pull existing repos
- Companion script normalizes folder timestamps to match latest commit dates

### 2. CLI Interface
- `starsync [options] [target-path]` / `bun src/cli.ts [options] [target-path]`
- Options: `--help`, `-h`
- Exit codes: 0 (success), 1 (runtime error including clone/pull failures), 2 (argument error)
- Target path resolution priority: positional > TARGET_PATH env > `<repo>/starred_repos`

### 3. Authentication
- GitHub Personal Access Token via `GITHUB_TOKEN` env var
- Scopes: `repo`, `read:user`
- Loaded from `.env` via dotenv

### 4. Sync Behavior
- Paginated fetch via `activity.listReposStarredByAuthenticatedUser` (100/page, auto-pagination)
- Sequential clone/pull via `execFileSync('git', ...)`
- Reports succeeded/failed counts
- Prints failure details if any repos failed

### 5. Companion Script: set-folder-dates
- `bun scripts/set-folder-dates.ts [options] [target-path]`
- Options: `--help`, `-h`, `--dry-run`
- Sets folder mtime to latest git commit date
- Skips non-git directories and repos with no commits
- Reports updated/skipped counts with timestamp tables

### 6. Quality Gate
- `bun run smoke:qc` = typecheck + lint + format:check
- `bun test` for unit tests
- Both must pass before commits

### 7. Technology Constraints
- Runtime: Bun >=1.3.14
- Language: TypeScript (strict, ES2022, ESM only)
- No framework, no database, no web UI
- Git operations via `execFileSync` (no shell interpolation)

---

## Verdict

| Check | Result |
|---|---|
| Document exists | ❌ No |
| Content accurate | N/A — no content to verify |
| References valid | N/A |
| Missing critical information | ❌ Entire document is missing |

**Status:** The document `.aidd/spec.md` is a required AIDD artifact that has been absent since project intake. This is the 4th review confirming its absence. The project is otherwise well-documented through compensating artifacts, but the formal spec should be created to fulfill the AIDD contract and provide an authoritative product reference.
