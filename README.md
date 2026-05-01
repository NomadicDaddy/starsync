# starsync

Clone or pull every starred GitHub repository to your local machine. Subsequent runs pull each existing repo to the latest commit; new stars are cloned.

Single-file Bun + TypeScript CLI plus a companion script for normalizing folder timestamps.

## Install

```sh
bun install
```

## Configuration

Copy `.env.example` to `.env` and set:

| Variable       | Required | Description                                               |
| -------------- | -------- | --------------------------------------------------------- |
| `GITHUB_TOKEN` | yes      | Personal access token with `repo` and `read:user` scopes. |
| `TARGET_PATH`  | no       | Where to sync repos. Defaults to `<repo>/starred_repos`.  |

A positional argument on the command line overrides `TARGET_PATH`.

## Usage

Sync all starred repos:

```sh
bun start
# or
bun index.ts [target-path]
```

Update each top-level repo folder's mtime to match its latest commit:

```sh
bun run set-folder-dates -- [--dry-run] [target-path]
```

| Option         | Description                                             |
| -------------- | ------------------------------------------------------- |
| `--help`, `-h` | Show usage                                              |
| `--dry-run`    | (set-folder-dates) preview without modifying timestamps |

Both commands exit with code 2 on unknown arguments and code 1 on runtime errors (including any clone/pull failures during sync).

## Scripts

| Script                     | What it runs                        |
| -------------------------- | ----------------------------------- |
| `bun start`                | `bun index.ts`                      |
| `bun run set-folder-dates` | `bun ./scripts/set-folder-dates.ts` |
| `bun run typecheck`        | `tsc --noEmit`                      |
| `bun run format`           | `prettier --write .`                |
| `bun run format:check`     | `prettier --check .`                |

## Scheduling

Schedule the sync via Windows Task Scheduler, cron, launchd, or any other periodic runner. The non-zero exit code on failure lets the scheduler surface problems instead of silently succeeding.

## License

MIT
