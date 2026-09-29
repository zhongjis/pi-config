# second-opinion

Runs `codex review` on current git changes or agent-selected session scope and posts the verdict into the pi session as a `second-opinion` message.

## What It Does

- `/codex:review` reviews current repo branch changes plus dirty files (staged, unstaged, untracked)
- `/codex:review session` asks the agent to choose session-relevant scope, then runs scoped Codex review via `codex_review_session_scope`
- Posts Codex output as a `second-opinion` message
- After review, prompts whether the agent should address comments using a conservative address-comments workflow
- Supports Escape / Ctrl-C to cancel a running review when in TUI mode
- Reports preflight failures (Codex missing, login missing, or no git repo for the selected review target) without starting a review

Requires `codex` CLI on PATH and a valid `codex login` session.

## Entry Points

- `/codex:review` — review branch changes plus dirty files.
- `/codex:review session` — the agent confirms scope, then calls `codex_review_session_scope`.

[index.ts](index.ts) registers the commands, tool, and events.
