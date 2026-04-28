# direnv

Loads direnv environment variables on session start and auto-reloads on changes.

## What It Does

- Runs `direnv export json` on session start to load environment variables into the process
- Watches `.envrc` and `.direnv/` for filesystem changes with debounced reload (300ms)
- Shows status bar indicator when direnv is blocked or errored
- Re-activates on session switch and session tree navigation
- Cleans up watchers on session shutdown

## Commands

- `/direnv` — Manually reload direnv environment variables

## Hooks

- `session_start`, `session_switch`, `session_tree` — Activate direnv and start file watchers
- `session_shutdown` — Stop watchers and deactivate

## Configuration

### Requirements

- `direnv` must be installed and in PATH
- `.envrc` must be allowed (`direnv allow` in your shell first)
