# Inline Skills

Load skills from inside a pi prompt. Type `$` plus part of a skill name, pick
from autocomplete (rows shown as `$skill:<name>`), and keep writing. On confirm
the editor stamps the token `$skill:<name>`; on submit the visible prompt is left
unchanged and the matching skill content is injected for that turn. `$skill:`
tokens stay in the prompt text, so rewinding and editing earlier prompts still
works. `/` is reserved for commands — skills never appear under `/`.
Already-loaded skills are not injected again on the same session branch, and
skills with `disable-model-invocation: true` work because the extension reads
skill files directly.

## Upstream

- Source: https://github.com/tifandotme/pi-extensions/tree/master/packages/pi-inline-skills
- Version: 1.0.5
- Commit: `49847944267affb4f11961dad10d44809f473cce` (master HEAD containing v1.0.5; 1.0.5 changeset `37740077983cfd5d6f7f5888de04ac3f2b0ed84e`)
- License: MIT — Copyright (c) 2026 Tifan Dwi Avianto (see `LICENSE`)
- Local changes: invocation token changed from upstream `/name` to `$skill:<name>` (see `AGENTS.md` → Local Tweaks); pi-native skill entries stripped from `/` autocomplete; vendored as flat-tier `index.ts`; upstream `package.json`/`tsconfig.json`/`CHANGELOG.md`/`assets/` omitted; README replaced.

## Commands

- `/loaded-skills`: List skills loaded in the current session.

## Hooks

- `session_start`: restore loaded-skill set from the branch; register the `$skill:` autocomplete provider.
- `session_tree`: refresh the loaded-skill set on branch switch.
- `tool_result`: mark a skill loaded when its `SKILL.md` is read via the `read` tool.
- `input`: detect `$skill:<name>` tokens, stage matching (not-yet-loaded) skill content for injection; keep prompt text unchanged.
- `before_agent_start`: inject the staged inline skill content as a displayed `inline-skill` message.

## Events

- Registers an `inline-skill` custom message renderer and appends `loaded-skill` session entries. No cross-extension events or RPC.
