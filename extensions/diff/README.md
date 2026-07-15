# diff

Opens [hunk](https://github.com/modem-dev/hunk) to review git changes — the working tree by default, with subcommands for staged, base, pr, commit, stash, and arbitrary refs.

## What It Does

- Routes `/diff [arg]` to the matching hunk invocation (see Commands below)
- For the default and `staged` views, checks first whether there is anything to review and exits early if not
- Suspends pi's TUI and hands the terminal to hunk (interactive multi-file review: sidebar navigation, syntax highlighting, untracked files)
- Resumes pi's TUI when hunk exits
- **Harvests the inline comments** you leave in hunk by polling the live session while it is open (`hunk session comment list --type all`), then hands the human-authored ones to the agent as a follow-up so it addresses them

Requires `hunk` on PATH and interactive (TUI) mode.

## Commands

| Command | Base it diffs against | "Show me…" | hunk invocation |
|---|---|---|---|
| `/diff` | working tree | uncommitted | `hunk diff` |
| `/diff staged` | index (alias: `cached`) | what's staged | `hunk diff --staged` |
| `/diff base` | `@{upstream}` merge-base | unpushed work (vs my remote branch) | `hunk diff $(git merge-base HEAD @{upstream})` |
| `/diff pr [<ref>]` | integration branch merge-base | the whole PR | `hunk diff $(git merge-base HEAD <origin/HEAD\|ref>)` |
| `/diff pr-walkthrough [<ref>]` | integration branch merge-base | the PR, **annotated by the agent** | agent writes sidecar → `hunk diff <sha> --agent-context notes.json` |
| `/diff <ref>` | a ref, direct | working tree vs that ref | `hunk diff <ref>` |
| `/diff commit` | last commit | most recent commit | `hunk show` |
| `/diff stash` | latest stash | stash entry | `hunk stash show` |

`base` and `pr` both resolve a base ref, take its merge-base with `HEAD`, then hand `hunk diff <sha>`. The only difference is **which** ref:

- **`/diff base`** — *what isn't on my remote yet.* Diffs against `@{upstream}` (your tracking branch), **not** the integration branch. On a pushed feature branch that's your unpushed commits + uncommitted changes (often empty when clean & pushed — that's expected, use `pr` for the PR view). Falls back to origin's default branch when the branch has no tracking branch.
- **`/diff pr [<ref>]`** — *the PR view.* Diffs against the integration branch, auto-resolved as `origin/HEAD` → `origin/main`/`origin/master`. Pass an explicit ref (`/diff pr develop`, `/diff pr upstream/main`) for fork, gitflow, or stacked-PR bases. Deliberately ignores `@{upstream}` (a pushed feature branch's upstream is itself).

> Run `git fetch` first — `base`/`pr` compare against your local remote-tracking refs, so the result is only as fresh as your last fetch. No auto-fetch.

## Review loop

While hunk is open, the extension polls the live session (~600ms) and keeps the latest snapshot of the inline comments you leave — hunk deregisters the session the instant its TUI quits (zero grace period), so a post-exit query would find nothing. On close, any human-authored comments are formatted as `file:line — summary` and sent to the agent as a user message instructing it to address each one — turning the diff view into a two-way review channel. No comments left → nothing is sent.

Comments are owned by hunk; the extension keeps no separate comment store. It filters to human-authored notes (`source: "user"`, or legacy comments that carry no source) so the agent never re-ingests its own `--agent-context` annotations. Any query/parse failure is a silent no-op.

## PR walkthrough (agent-narrated)

`/diff pr-walkthrough [<ref>]` flips the review loop: instead of *you* annotating for the agent, the **agent annotates the PR for you**. Two phases:

1. **Analyze** — the command resolves the PR base (same logic as `/diff pr`) and hands the agent a prompt to read `git diff <sha>` and write a [hunk agent-context sidecar](https://github.com/modem-dev/hunk/blob/main/docs/agent-workflows.md): a JSON file of per-hunk summaries and rationale. The command does **not** launch hunk itself.
2. **Open** — the agent calls the `open_pr_walkthrough` tool, which launches `hunk diff <sha> --agent-context <sidecar> --agent-notes` so the annotations render inline beside each hunk. Closing the review harvests any comments *you* leave (the Review loop above), so the walkthrough and your feedback compose into one conversation.

Sidecar schema (line numbers are on the new side of each file):

```json
{
  "version": 1,
  "summary": "one-line PR summary",
  "files": [
    { "path": "src/x.ts", "summary": "what changed in this file",
      "annotations": [
        { "newRange": [12, 20], "summary": "what this hunk does", "rationale": "why it matters" }
      ] }
  ]
}
```

Single terminal — the tool suspends pi's TUI and launches hunk like any other `/diff`, so no separate hunk window is needed.

The `open_pr_walkthrough` tool is **command-gated, not allowlisted**: it is registered but kept out of every mode's `extension_tools` list. `/diff pr-walkthrough` force-enables it for the session via `pi.setActiveTools`, and the tool removes itself from the active set after a successful launch. So it stays invisible to the agent until you actually ask for a walkthrough — and it works in any mode without per-mode frontmatter edits.
