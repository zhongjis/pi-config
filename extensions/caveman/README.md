# Caveman

Token-compression prompt injection for Pi. Adds the active Caveman skill as the `caveman` system-prompt section of every session that loads this extension: top-level sessions, plus subagents whose `extensions:` rules select it (no bundled agent does). Levels map to upstream's three skills: `full` (`caveman`, the voice), `ultra` (`ultracave`, grammar stripped), `wenyan` (`megacave`, Classical Chinese).

## Upstream

- **Source:** https://github.com/JuliusBrussee/caveman
- **Version:** `main` at `d262ab3882952a59312ff3537cd86d894523c5ab` (Caveman 4.0.1)
- **License:** Apache-2.0; copied in `LICENSE`, attribution in `NOTICE`
- **Adapted:** Pi-native extension wrapper, persistent `~/.pi/agent/caveman.json` config, session-entry overrides, and `before_agent_start` injection of the level's skill.

## Entry Points

- `/caveman [full|ultra|wenyan|off]` sets or disables caveman for this session; `/caveman config` sets persistent defaults. Commands and hooks are registered in [`index.ts`](index.ts).

## Configuration

Persisted in `~/.pi/agent/caveman.json`; keys and defaults are defined in [`config.ts`](config.ts). Unknown levels in config or session entries are ignored.

## Local Tweaks

- Rules are injected as the `caveman` prompt section (`event.systemPromptOptions.sections.caveman`) instead of being appended to the system prompt; the handler returns no `systemPrompt`.
- The skill's `## Persistence` section is not injected: this extension owns mode persistence and status.

## Local Additions

- The prompt source is the installed skill at `~/.pi/agent/skills/{caveman,ultracave,megacave}/SKILL.md`, chosen by level. YAML frontmatter and the `#` title are excluded. A skill missing its file or its `## Rules` / `## When to break the rules` sections leaves caveman inactive with a warning; selecting that level reports an error. Parsing lives in [`prompt.ts`](prompt.ts).
