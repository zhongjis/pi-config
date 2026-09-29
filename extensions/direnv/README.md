# direnv

Loads direnv environment variables on session start and auto-reloads on `.envrc` / `.direnv/` changes.

## Upstream

- Source: https://github.com/rytswd/pi-agent-extensions/tree/main/direnv
- Version: `main` (no releases/tags published)
- Commit: `9df8ca72acda83b4249f50c4b0211ac217d94624`
- License: MIT
- Local changes: stale-context guards, session switch/tree reloads, shared debounce, local README/AGENTS docs

## Entry Points

- `/direnv` — manually reload direnv environment variables for the current session.
- direnv activates on session start, session switch, and tree navigation. The command and hooks are registered in [`index.ts`](index.ts).

## Settings / Configuration

- Requires `direnv` in `PATH`.
- Requires `.envrc` to be allowed first with `direnv allow`.
- Watches `.envrc` and `.direnv/` with a 300 ms debounced reload.

## Local Additions

- Preserves local stale-context/session-version guards to avoid UI updates against dead extension contexts.
- Uses repo shared `debounce` helper instead of an inline reload timer.
