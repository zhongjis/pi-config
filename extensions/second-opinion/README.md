# second-opinion

Runs `codex review` on git changes and posts the review verdict into the pi session as a `second-opinion` message.

## What It Does

- Auto-detects what to review (uncommitted changes, upstream base, or HEAD commit) when called with no argument
- Spawns `codex review` with the appropriate flags and streams live progress via a TUI spinner widget
- Collects the final review text from stdout and posts it as a `second-opinion` message (display mode — no auto-turn trigger, so you decide what to do next)
- Supports Escape / Ctrl-C to cancel a running review when in TUI mode
- Reports preflight failures (codex not on PATH, not logged in, not in a git repo) without starting a review

Requires `codex` CLI on PATH and a valid `codex login` session.

## Commands

| Command | Targets | codex flags |
|---|---|---|
| `/codex:review` | auto-detect: uncommitted → upstream base → HEAD commit | `--uncommitted` \| `--base <ref>` \| `--commit HEAD` |
| `/codex:review uncommitted` | working tree changes | `--uncommitted` |
| `/codex:review base [ref]` | upstream or origin HEAD (pass ref to override) | `--base <ref>` |
| `/codex:review commit [sha]` | specific commit (default: HEAD) | `--commit <sha>` |

## Future reviewers

The codex-specific argv building in `src/detect.ts` is intentionally isolated — adding a `/claude:review` command in the future means adding a new argv builder and a new `registerCommand` call, with no changes to this file's logic.
