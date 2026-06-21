# smart-sessions

Maintains an LLM-generated one-line session summary as the session name, so active sessions and `/resume` entries show current work instead of only the first prompt.

## Upstream

- Source: https://github.com/pasky/pi-session-summary
- Last synced version: 1.0.1
- Last synced commit: 49902da5f42bd3c6d8954bbcf4d8bebeb220ed4b
- License: MIT
- Local changes: vendored into existing `extensions/smart-sessions/` path; notification level adapted from upstream `success` to local Pi-supported `info`.

## Commands

- `/summary:settings` — Create/show `~/.pi/agent/session-summary.json` settings file.
- `/summary:update` — Force an immediate summary update.
- `/summary:clear` — Clear current summary/session name.
- `/summary:cost` — Show model, calls, token usage, and cost for this session.

## Hooks

- `session_start` — Load settings, reset in-memory counters, restore existing session name.
- `agent_end` — Debounce and update the session summary/name after agent turns.

## Settings / Configuration

Global config: `~/.pi/agent/session-summary.json`.
Project override: `.pi/session-summary.json`.

Fields:
- `provider`, `model` — Optional explicit summary model. When either is blank or missing, model selection uses the `smart-sessions.summary` role from `~/.pi/agent/tool_models.json` / `.pi/tool_models.json`.
- `debounceSeconds` — Minimum seconds between LLM calls. Default: `60`.
- `maxTokens` — Max tokens for summary response. Default: `300`.
- `resummarizeTokenThreshold` — Token threshold for full re-summary. Default: `40000`.
- `showWidget` — Show summary/staleness widget below editor. Default: `false`.
- `verbose` — Notify whenever summary changes. Default: `false`.

## Local Additions

None. Local repo only keeps the previous extension directory name for compatibility with existing harness wiring.
