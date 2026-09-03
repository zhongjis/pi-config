# Caveman

Token-compression prompt injection for Pi. Appends terse-communication rules to every agent session's system prompt (top-level and spawned subagents) whenever a caveman level is configured. Three local levels: `lite` (professional but tight), `full` (classic caveman), `ultra` (maximum concise clarity without rewriting code symbols).

## Upstream

- **Source:** https://github.com/JuliusBrussee/caveman
- **Version:** `main` at `3b74643f4d910f496babd4e634b1ba7168816f14`
- **Prompt provenance:** latest SKILL-touch commit `8909f6af8806897cbb8330c11028eee168ad7cc7`; prompt-body commit `b4335705d436f5110386a1c39c6d8aed5002aeeb`
- **Synced:** 2026-09-02
- **License:** MIT; copied in `LICENSE`
- **Adapted:** Pi-native extension wrapper, persistent `~/.pi/agent/caveman.json` config, session-entry overrides, global-first prompt loading, level-configured `before_agent_start` injection (all agent sessions), and runtime normalization for unsupported stop/off/wenyan behavior.

## Commands

- `/caveman [lite|full|ultra]` — Set level for this session
- `/caveman` — Show current status
- `/caveman config` — Set persistent default level and status bar visibility

## Configuration

Persisted in `~/.pi/agent/caveman.json`:

- `defaultLevel` — `off`, `lite`, `full`, or `ultra`
- `statusVisibility` — `active` or `hidden`

## Hooks

- `session_start` — restores config/session state and status
- `before_agent_start` — appends the active caveman prompt to every agent session's system prompt (top-level and subagents) when a level is configured
- `session_shutdown` — clears status and runtime state

## Local Additions

- Runtime prompt source is `~/.pi/agent/skills/caveman/SKILL.md` when present; its YAML frontmatter is excluded from parsing and injection.
- `upstream-caveman.SKILL.md` stores the upstream skill body without YAML frontmatter as the fallback.
- `prompt.ts` parses upstream sections and injects only locally supported level behavior.
