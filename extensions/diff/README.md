# diff

Shows git-changed files and opens the selected file in VS Code's diff view.

## What It Does

- Runs `git status --porcelain` to list modified, added, deleted, renamed, and untracked files
- Presents an interactive file picker with colored status indicators (M=yellow, A=green, D=red, ?=muted)
- Opens selected file in VS Code diff view via `git difftool -y --tool=vscode`
- Falls back to `code -g <file>` for untracked files or if difftool fails
- Supports left/right arrow paging in the file list

## Commands

- `/diff` — Show git changes and open selected file in VS Code diff view
