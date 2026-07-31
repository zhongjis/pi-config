# Caveman

Token-compression prompt injection for Pi. Appends terse-communication rules to every agent session's system prompt (top-level and spawned subagents) whenever a caveman level is configured. Three local levels: `lite` (professional but tight), `full` (classic caveman), `ultra` (abbreviations, arrows, one word when enough).

## Upstream

- **Source:** https://github.com/JuliusBrussee/caveman
- **Version:** `main` at `25d22f864ad68cc447a4cb93aefde918aa4aec9f`
- **Synced:** 2026-06-29
- **License:** MIT; copied in `LICENSE`
- **Adapted:** Pi-native extension wrapper, persistent `~/.pi/agent/caveman.json` config, session-entry overrides, level-configured `before_agent_start` injection (all agent sessions), and runtime prompt normalization for unimplemented upstream stop/off behavior.

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

- `upstream-caveman.SKILL.md` stores the upstream skill body without YAML frontmatter.
- `prompt.ts` parses upstream sections and injects only locally supported level behavior.
