# diff

Opens [hunk](https://github.com/modem-dev/hunk) to review git changes — the working tree by default, with subcommands for staged, base, pr, commit, stash, and arbitrary refs.

## What It Does

- Routes `/diff [arg]` to the matching hunk invocation (see Commands below)
- For the default and `staged` views, checks first whether there is anything to review and exits early if not
- Suspends pi's TUI and hands the terminal to hunk (interactive multi-file review: sidebar navigation, syntax highlighting, untracked files)
- Resumes pi's TUI when hunk exits
- **Harvests any inline comments** you left in hunk (`hunk session comment list --json`) and sends them to the agent as a follow-up so it addresses them

Requires `hunk` on PATH and interactive (TUI) mode.

## Commands

| Command | Base it diffs against | "Show me…" | hunk invocation |
|---|---|---|---|
| `/diff` | working tree | uncommitted | `hunk diff` |
| `/diff staged` | index (alias: `cached`) | what's staged | `hunk diff --staged` |
| `/diff base` | `@{upstream}` merge-base | unpushed work (vs my remote branch) | `hunk diff $(git merge-base HEAD @{upstream})` |
| `/diff pr [<ref>]` | integration branch merge-base | the whole PR | `hunk diff $(git merge-base HEAD <origin/HEAD\|ref>)` |
| `/diff <ref>` | a ref, direct | working tree vs that ref | `hunk diff <ref>` |
| `/diff commit` | last commit | most recent commit | `hunk show` |
| `/diff stash` | latest stash | stash entry | `hunk stash show` |

`base` and `pr` both resolve a base ref, take its merge-base with `HEAD`, then hand `hunk diff <sha>`. The only difference is **which** ref:

- **`/diff base`** — *what isn't on my remote yet.* Diffs against `@{upstream}` (your tracking branch), **not** the integration branch. On a pushed feature branch that's your unpushed commits + uncommitted changes (often empty when clean & pushed — that's expected, use `pr` for the PR view). Falls back to origin's default branch when the branch has no tracking branch.
- **`/diff pr [<ref>]`** — *the PR view.* Diffs against the integration branch, auto-resolved as `origin/HEAD` → `origin/main`/`origin/master`. Pass an explicit ref (`/diff pr develop`, `/diff pr upstream/main`) for fork, gitflow, or stacked-PR bases. Deliberately ignores `@{upstream}` (a pushed feature branch's upstream is itself).

> Run `git fetch` first — `base`/`pr` compare against your local remote-tracking refs, so the result is only as fresh as your last fetch. No auto-fetch.

## Review loop

After every `/diff` review, the extension queries the live hunk session for inline comments. If you left any, they are formatted as `file:line — summary` and sent to the agent as a user message instructing it to address each one — turning the diff view into a two-way review channel. No comments left → nothing is sent.

Comments are owned by hunk; the extension keeps no separate comment store. Querying when no session/comment exists is a silent no-op.
