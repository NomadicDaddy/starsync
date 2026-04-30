# starsync

A simple set of scripts to automatically backup/synchronize (clone or pull) all your **starred repositories** from GitHub to your local machine.

## Prerequisites

- [Bun](https://bun.sh/) (or Node.js with `ts-node`)
- A [GitHub Personal Access Token (PAT)](https://github.com/settings/tokens) with `repo` and `read:user` permissions (no added permissions required)

## Setup

1. **Install dependencies:**

    ```bash
    bun install
    ```

2. **Configure your environment variables:**
   Copy the example file to `.env`:

    ```bash
    cp .env.example .env
    ```

    Edit `.env` and paste your GitHub token:

    ```env
    GITHUB_TOKEN=your_personal_access_token_here

    # Optional: Set the target path where repositories will be synced. Defaults to current working directory.
    # TARGET_PATH=/path/to/your/sync/folder
    ```

## Usage

Start the sync process:

```bash
bun run start
```

This will clone or pull every starred repository from your GitHub account directly into your `TARGET_PATH` (or a `starred_repos` directory in the current working directory if `TARGET_PATH` is not set).

## Folder dates

After syncing, optionally update each top-level repository folder's modified time to match that repo's latest commit:

```bash
bun run set-folder-dates
```

## Scheduling

You can schedule the sync to run automatically using Windows Task Scheduler, cron, or another task scheduler.
