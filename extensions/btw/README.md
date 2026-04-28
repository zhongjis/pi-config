# btw

Side question command — ask a quick question without interrupting the main session thread.

## What It Does

- `/btw <question>` runs a one-shot LLM completion using the current session context
- Answer appears in a bordered widget overlay (not in the main conversation)
- Uses the current session's model and auth credentials
- Converts tool call/result blocks to text summaries to avoid provider-specific issues (e.g., Bedrock requires toolConfig)
- Shows loading spinner while waiting for response
- Debug entries logged to session JSONL as `btw:debug` custom type
- Dismissible with Esc

## Commands

- `/btw <question>` — Ask a side question in a separate widget
- `/btw:clear` — Clear the BTW widget

## Hooks

- `session_start`, `session_tree` — Restore visible widget state on session load
- `session_shutdown` — Abort active requests and clean up
