# direnv

Loads direnv environment variables on session start and auto-reloads on `.envrc` / `.direnv/` changes.

## Upstream

- Source: https://github.com/rytswd/pi-agent-extensions/tree/main/direnv
- Last synced version: `main` (no releases/tags published)
- Last synced commit: `9df8ca72acda83b4249f50c4b0211ac217d94624`
- Sync date: 2026-05-05
- License: MIT
- Local changes: stale-context guards, session switch/tree reloads, shared debounce, local README/AGENTS docs

## Commands

- `/direnv` — Manually reload direnv environment variables for the current session.

## Hooks

- `session_start` — Activates direnv and starts file watchers.
- `session_switch`, `session_tree` — Re-activates direnv for the new active session context.
- `session_shutdown` — Stops watchers and clears active context.

## Settings / Configuration

- Requires `direnv` in `PATH`.
- Requires `.envrc` to be allowed first with `direnv allow`.
- Watches `.envrc` and `.direnv/` with a 300 ms debounced reload.

## Local Additions

- Preserves local stale-context/session-version guards to avoid UI updates against dead extension contexts.
- Uses repo shared `debounce` helper instead of an inline reload timer.
