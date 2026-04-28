# tools

Interactive tool enable/disable UI with per-branch persistence.

## What It Does

- Shows a settings list of all registered tools with enabled/disabled toggle
- Persists tool configuration per session branch via `appendEntry("tools-config", ...)`
- Restores saved tool state on session start and session tree navigation
- Uses pi's `setActiveTools` API to apply changes immediately

## Commands

- `/tools` — Open interactive tool configuration (↑↓ navigate, Enter toggle, Esc close)

## Hooks

- `session_start`, `session_tree` — Restore tool state from branch history
