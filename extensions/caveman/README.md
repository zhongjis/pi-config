# Caveman

Token-compression prompt injection for Pi. Adds terse-communication rules as the `caveman` system-prompt section of every agent session (top-level and spawned subagents) whenever a caveman level is configured. Three local levels: `lite` (professional but tight), `full` (classic caveman), `ultra` (maximum concise clarity without rewriting code symbols).

## Upstream

- **Source:** https://github.com/JuliusBrussee/caveman
- **Version:** `main` at `3b74643f4d910f496babd4e634b1ba7168816f14`
- **License:** MIT; copied in `LICENSE`
- **Adapted:** Pi-native extension wrapper, persistent `~/.pi/agent/caveman.json` config, session-entry overrides, and level-specific `before_agent_start` injection built from the caveman Skill (all agent sessions).

## Entry Points

- `/caveman [lite|full|ultra|off]` sets or disables caveman for this session; `/caveman config` sets persistent defaults. Commands and hooks are registered in [`index.ts`](index.ts).

## Configuration

Persisted in `~/.pi/agent/caveman.json`; keys and defaults are defined in [`config.ts`](config.ts).

## Local Tweaks

- Rules are injected as the `caveman` prompt section (`event.systemPromptOptions.sections.caveman`) instead of being appended to the system prompt; the handler returns no `systemPrompt`.

## Local Additions

- The only prompt source is the caveman Skill at `~/.pi/agent/skills/caveman/SKILL.md`. YAML frontmatter is excluded from parsing and injection. When that file is missing, caveman stays inactive and warns.
- Injected text keeps the active level's Intensity row and examples, plus an override line where Rules conflict with the active level. Parsing lives in [`prompt.ts`](prompt.ts).
