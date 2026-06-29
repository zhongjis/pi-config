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

## Commands

| Command | Target | Behavior |
|---|---|---|
| `/codex:review` | Current repo branch + dirty files | Runs branch review vs upstream/origin base when branch has commits, then dirty review when working tree has changes |
| `/codex:review session` | Agent-selected session scope | Sends a follow-up prompt asking the agent to confirm repo/path scope, then the agent calls `codex_review_session_scope` |

## Tools

| Tool | Caller | Purpose |
|---|---|---|
| `codex_review_session_scope` | Agent after `/codex:review session` | Runs Codex against confirmed repo scopes. Included/excluded paths are passed as prompt scope, not hard CLI path filters. |

## Events

| Event | When |
|---|---|
| `user-prompted` | Emitted before the post-review prompt asking whether the agent should address Codex comments. |
