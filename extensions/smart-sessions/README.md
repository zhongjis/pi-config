# smart-sessions

Auto-names sessions after the first agent loop using a cheap model.

## Upstream

- **Source:** https://github.com/HazAT/pi-smart-sessions
- **Adapted:** Lightly adapted for this config. Core logic preserved.

## What It Does

- Detects `/skill:<name> <prompt>` patterns in user input
- Sets an immediate temporary session name: `[skill-name] <first 60 chars>`
- Calls `claude-haiku-4-5` (or falls back to the current model) to generate a 5-10 word summary
- Updates the session name with the LLM-generated summary
- Only runs once per session (skips if already named)

## Hooks

- `session_start` — Check if session already has a name
- `input` — Detect skill pattern, set temporary name, trigger async summarization
