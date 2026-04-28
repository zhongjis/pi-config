# distilled-footer

Compact two-line footer replacing the default pi footer with essential session info.

## What It Does

**Line 1:** Project directory (basename if git, full path otherwise) · git branch · session name · session ID (8-char)

**Line 2:** Context usage % / window size · model ID / thinking level · cost (with subscription indicator) · token I/O counts (↑input ↓output, cache read/write)

**Line 3 (conditional):** Extension statuses (agent mode, etc.) on left, infrastructure statuses (MCP, LSP) on right.

- Color-coded context usage (green/yellow/red by percentage)
- Color-coded cost ($10+ red, $1+ yellow)
- Aggregates token usage from all assistant messages in the session
- Reinstalls on model changes to keep model line current

## Hooks

- `session_start`, `model_select` — Install/reinstall the footer
