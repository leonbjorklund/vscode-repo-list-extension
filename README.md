## Repo Launcher

List repositories and open in code with one click.

Add a single repository or select a folder to scan for Git repositories up to four levels deep. Repositories can be grouped and reordered with drag and drop.

<img src="https://github.com/leonbjorklund/vscode-repo-list-extension/raw/main/docs/activity-bar-view.png?v=2" width="360" alt="Activity bar view" />

## Settings

- `repoLauncher.openBehavior` — open in new window or replace current window
- `repoLauncher.showPathsByDefault` — show repository paths
- `repoLauncher.scan.exclude` — folders skipped during scans. Defaults to `.git`, `node_modules`, `AppData`, `Library`, `.cache`, `.npm`, and `.yarn`.

## Feature Request

The built-in `File: Open Recent` command gets close to this workflow, but the recent list gets noisy. Native support for listing and opening specific folders in code would let me gladly retire this extension.
