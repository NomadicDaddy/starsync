# starsync

A simple script written in TypeScript to automatically synchronize (clone or pull) all your **starred repositories** from GitHub to your local machine.

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

After syncing, update each top-level repository folder's modified time to match that repo's latest commit:

```powershell
bun run set-folder-dates -- -RootPath D:\packages\github
```

If `-RootPath` is omitted, the script uses `TARGET_PATH` from `.env`, then falls back to `starred_repos`.
