# diff

Opens [hunk](https://github.com/modem-dev/hunk) to review git changes — the working tree by default, with subcommands for staged, base, commit, stash, and arbitrary refs.

## What It Does

- Routes `/diff [arg]` to the matching hunk invocation (see Commands below)
- For the default and `staged` views, checks first whether there is anything to review and exits early if not
- Suspends pi's TUI and hands the terminal to hunk (interactive multi-file review: sidebar navigation, syntax highlighting, untracked files)
- Resumes pi's TUI when hunk exits
- **Harvests any inline comments** you left in hunk (`hunk session comment list --json`) and sends them to the agent as a follow-up so it addresses them

Requires `hunk` on PATH and interactive (TUI) mode.

## Commands

- `/diff` — working-tree changes (default)
- `/diff staged` — staged changes (alias: `cached`) → `hunk diff --staged`
- `/diff base` — changes since the branch diverged from its upstream → `hunk diff <merge-base>`
- `/diff commit` — the most recent commit → `hunk show`
- `/diff stash` — the latest stash entry → `hunk stash show`
- `/diff <ref>` — working tree compared against a ref (HEAD, branch, sha) → `hunk diff <ref>`

`base` resolves its upstream as the tracking branch (`@{upstream}`), falling back to origin's default branch (`origin/HEAD`, then `origin/main`/`origin/master`).

## Review loop

After every `/diff` review, the extension queries the live hunk session for inline comments. If you left any, they are formatted as `file:line — summary` and sent to the agent as a user message instructing it to address each one — turning the diff view into a two-way review channel. No comments left → nothing is sent.

Comments are owned by hunk; the extension keeps no separate comment store. Querying when no session/comment exists is a silent no-op.
