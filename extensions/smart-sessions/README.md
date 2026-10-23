# smart-sessions

Maintains an LLM-generated one-line session summary as the session name, so active sessions and `/resume` entries show current work instead of only the first prompt.

## Upstream

- Source: https://github.com/pasky/pi-session-summary
- Version: 1.0.1
- Commit: 49902da5f42bd3c6d8954bbcf4d8bebeb220ed4b
- License: MIT
- Adapted: lives at `extensions/smart-sessions/`; notifications use the Pi-supported `info` level instead of upstream `success`.

## Herdr Tab Titles

Inside Herdr, the existing summary request also generates a separate meaningful tab title; the Pi session summary stays independent. Titles use `[w] ` followed by at most four words, counting whitespace and hyphens as separators.

Only tabs whose current label starts with `[w]`, or whose numeric label equals their current one-based position in the workspace tab list, are eligible. Every other label is preserved, including other bracketed prefixes and ordinary custom names. Removing or replacing `[w]` opts out. A manually chosen positional number is indistinguishable from a default label and can be overwritten.

Updates follow the existing summary timing and debounce, not startup. [herdr.ts](herdr.ts) checks the explicit current tab's live label immediately before renaming; [index.ts](index.ts) owns the shared summary request. Outside Herdr, summaries follow the plain one-line path.

## Entry Points

- `/summary:update` forces an update; `/summary:settings`, `/summary:clear`, and `/summary:cost` manage settings, the name, and usage. [index.ts](index.ts) registers them.

## Settings / Configuration

Global config: `~/.pi/agent/session-summary.json`.
Project override: `.pi/session-summary.json`.

When `provider` or `model` is blank, the `smart-sessions.summary` role from `tool_models.json` selects the model. [index.ts](index.ts) defines the remaining keys and defaults.
