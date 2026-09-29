# tools

Interactive tool enable/disable UI with per-branch persistence.

## What It Does

- Shows a settings list of all registered tools with enabled/disabled toggle
- Fuzzy search box filters tools by name as you type
- Persists tool configuration per session branch via `appendEntry("tools-config", ...)`
- Restores saved tool state on session start and session tree navigation
- Uses pi's `setActiveTools` API to apply changes immediately

## Entry Points

- `/tools` — open the tool list (type to search, Enter/Space toggle, Esc close). [index.ts](index.ts) registers the command and hooks.
