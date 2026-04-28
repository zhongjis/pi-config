# Caveman

Token-compression prompt injection. Prepends terse-communication rules to the system prompt on every agent turn. Three intensity levels: `lite` (professional but tight), `full` (classic caveman — no articles, fragments OK), `ultra` (abbreviations, arrows, one word when one word enough).

Only injected into top-level persisted sessions (not subagents).

## Commands

- `/caveman [lite|full|ultra]` — Set level for this session
- `/caveman` — Show current status
- `/caveman config` — Set persistent default level and status bar visibility

## Configuration

Persisted in `~/.pi/agent/caveman.json`:

- `defaultLevel` — `lite`, `full`, or `ultra`
- `statusVisibility` — show/hide status bar indicator

## Hooks

- `before_agent_start` — injects the caveman prompt into the system message
- `session_start` — restores saved state from config

## Files

- `index.ts` — extension entry point
- `config.ts` — persistence layer
- `prompt.ts` — skill file parsing
- `state.ts` — runtime state management
- `session-gate.ts` — top-level session check
- `upstream-caveman.SKILL.md` — vendored prompt content

## Upstream

Prompt content vendored from https://github.com/JuliusBrussee/caveman
