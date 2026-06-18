# diff

Opens [hunk](https://github.com/modem-dev/hunk) to review the current git working-tree changes.

## What It Does

- Runs `git status --porcelain`; if the working tree is clean, notifies and exits
- Suspends pi's TUI and hands the terminal to hunk via `hunk diff`
- hunk shows an interactive multi-file review stream (sidebar navigation, syntax highlighting), including untracked files
- Resumes pi's TUI when hunk exits

Requires `hunk` on PATH and interactive (TUI) mode.

## Commands

- `/diff` — Review git working-tree changes in hunk
