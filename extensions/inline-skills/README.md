# Inline Skills

Load skills or explicitly select one saved agent graph from inside a Pi prompt. Type `$` plus part of a skill or graph name and pick an autocomplete row. The editor inserts `$skill:<name>` or `$graph:<name>` and leaves the token visible when submitted.

A `$skill:` token injects matching skill content for that turn. Already-loaded skills are not injected again on the same session branch. Skills with `disable-model-invocation: true` work because the extension reads skill files directly. Put the cursor inside an existing skill token to replace the whole token. `/` remains reserved for commands.

A `$graph:` token authorizes exactly one resolvable saved graph for the current Pi session. The parent orchestrator receives the unchanged full prompt plus its saved description and input schema, then constructs input that satisfies the schema or asks for values that cannot be inferred. A matching call with invalid input is blocked without consuming authorization; a valid matching call consumes it. The guard then blocks second or unrelated calls through extension follow-up turns until the next ordinary user input. Unused authorization permits exactly one tokenless user clarification turn, and session start/tree changes clear authorization. Distinct graph tokens, missing or ambiguous graphs, disabled graph support, inline graphs, and unrelated graphs are rejected. Declared nested subgraphs execute only through the selected graph's runtime.

## Upstream

- Source: https://github.com/tifandotme/pi-extensions/tree/master/packages/pi-inline-skills
- Version: 1.0.5
- Commit: `49847944267affb4f11961dad10d44809f473cce` (master HEAD containing v1.0.5; 1.0.5 changeset `37740077983cfd5d6f7f5888de04ac3f2b0ed84e`)
- License: MIT — Copyright (c) 2026 Tifan Dwi Avianto (see `LICENSE`)
- Local changes: invocation token changed from upstream `/name` to `$skill:<name>`; `$graph:<name>` adds explicit saved-graph opt-in; Pi-native skill entries are stripped from `/` autocomplete; vendored as flat-tier `index.ts`; upstream `package.json`/`tsconfig.json`/`CHANGELOG.md`/`assets/` omitted; README replaced.

## Commands

- `/loaded-skills`: List skills loaded in the current session.

## Hooks

- `session_start`: clear graph authorization, restore loaded-skill state, and register `$skill:` plus resolver-backed `$graph:` autocomplete.
- `session_tree`: clear graph authorization and refresh the loaded-skill set on branch switch.
- `tool_result`: mark a skill loaded when its `SKILL.md` is read via the `read` tool.
- `input`: stage matching skills, validate one visible saved-graph token, and advance or clear session-bound authorization without changing prompt text.
- `before_agent_start`: inject staged skill content and saved-graph orchestration context.
- `tool_call`: coerce and validate matching graph input against its declared schema before consuming authorization, then retain the guard against later calls.
- `agent_end`: clear unused authorization only after its single clarification turn ends without a matching call.

## Events

- Registers an `inline-skill` custom message renderer and appends `loaded-skill` session entries. Imports the subagents saved-graph resolver; no cross-extension events or RPC.
