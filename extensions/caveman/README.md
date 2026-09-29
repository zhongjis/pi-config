# Caveman

Token-compression prompt injection for Pi. Appends terse-communication rules to every agent session's system prompt (top-level and spawned subagents) whenever a caveman level is configured. Three local levels: `lite` (professional but tight), `full` (classic caveman), `ultra` (maximum concise clarity without rewriting code symbols).

## Upstream

- **Source:** https://github.com/JuliusBrussee/caveman
- **Version:** `main` at `3b74643f4d910f496babd4e634b1ba7168816f14`
- **Prompt provenance:** `SKILL.md` at `8909f6af8806897cbb8330c11028eee168ad7cc7`; prompt body at `b4335705d436f5110386a1c39c6d8aed5002aeeb`
- **License:** MIT; copied in `LICENSE`
- **Adapted:** Pi-native extension wrapper, persistent `~/.pi/agent/caveman.json` config, session-entry overrides, global-first prompt loading, level-configured `before_agent_start` injection (all agent sessions), and runtime normalization for unsupported stop/off/wenyan behavior.

## Entry Points

- `/caveman [lite|full|ultra]` sets the level for this session; `/caveman config` sets persistent defaults. Commands and hooks are registered in [`index.ts`](index.ts).

## Configuration

Persisted in `~/.pi/agent/caveman.json`; keys and defaults are defined in [`config.ts`](config.ts).

## Local Additions

- Runtime prompt source is `~/.pi/agent/skills/caveman/SKILL.md` when present; its YAML frontmatter is excluded from parsing and injection.
- `upstream-caveman.SKILL.md` stores the upstream skill body without YAML frontmatter as the fallback.
- `prompt.ts` parses upstream sections and injects only locally supported level behavior.
