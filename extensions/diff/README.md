# diff

Opens [hunk](https://github.com/modem-dev/hunk) to review git changes — the working tree by default, with subcommands for staged, base, commit, stash, and arbitrary refs.

## What It Does

- Routes `/diff [arg]` to the matching hunk invocation (see Commands below)
- For the default and `staged` views, checks first whether there is anything to review and exits early if not
- Suspends pi's TUI and hands the terminal to hunk (interactive multi-file review: sidebar navigation, syntax highlighting, untracked files)
- Resumes pi's TUI when hunk exits

Requires `hunk` on PATH and interactive (TUI) mode.

## Commands

- `/diff` — working-tree changes (default)
- `/diff staged` — staged changes (alias: `cached`) → `hunk diff --staged`
- `/diff base` — changes since the branch diverged from its upstream → `hunk diff <merge-base>`
- `/diff commit` — the most recent commit → `hunk show`
- `/diff stash` — the latest stash entry → `hunk stash show`
- `/diff <ref>` — working tree compared against a ref (HEAD, branch, sha) → `hunk diff <ref>`

`base` resolves its upstream as the tracking branch (`@{upstream}`), falling back to origin's default branch (`origin/HEAD`, then `origin/main`/`origin/master`).
