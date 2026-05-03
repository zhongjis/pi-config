# Boomerang

Vendored `pi-boomerang` extension for token-efficient autonomous task execution. It runs a task, summarizes the resulting branch with Pi's session tree summarization, then hands concise context back to the orchestrator.

## Upstream

- Source: https://github.com/nicobailon/pi-boomerang
- Last synced version: 0.6.5
- Last synced commit: `ea543818f0d3b92bc427e179cfe75d0984553f36`
- License: not declared upstream
- Local changes summary: copied into `extensions/boomerang/`, kept code/test behavior intact, replaced README with local repo format, omitted upstream package files because root dependencies already provide required packages.

## Tools

### `boomerang`

Agent-callable tool, disabled by default until `/boomerang tool on`.

Parameters:

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `task` | string | No | Task to execute; supports `--rethrow N`. Omit to set/collapse an anchor. |

## Commands

- `/boomerang <task>` — run task autonomously, then summarize context.
- `/boomerang <task> --rethrow N` — run repeated passes with summaries between passes.
- `/boomerang <task> --loop N` — compatibility alias for `--rethrow N`.
- `/boomerang /a -> /b -> /c` — chain prompt templates before summarizing.
- `/boomerang auto [on|off|toggle|status]` — one-shot wrapping for next normal prompt.
- `/boomerang anchor [show|clear]` — set, inspect, or clear shared summary anchor.
- `/boomerang tool [on [guidance]|off]` — enable/disable agent-callable tool.
- `/boomerang guidance [text|clear]` — set or clear tool guidance.
- `/boomerang-cancel` — abort active boomerang without summarizing.
- `Ctrl+Alt+B` — toggle one-shot auto-boomerang mode.

## Hooks

- `input` — captures next prompt when auto mode is enabled.
- `before_agent_start` — injects boomerang instructions, tool guidance, optional skill content.
- `agent_end` — advances chains, starts queued tool tasks, collapses context.
- `session_before_tree` — provides generated summary for tree navigation.
- `session_before_compact` — prevents immediate compaction of freshly summarized branch state.
- `session_start` / `session_switch` — clears transient boomerang state.

## Settings / Configuration

Config persists at `~/.pi/agent/boomerang.json`.

Fields:

- `toolEnabled` — boolean; whether agent-callable `boomerang` tool is enabled.
- `toolGuidance` — string or null; extra system-prompt guidance for tool use.

## Events

Uses Pi lifecycle events only; no custom cross-extension event channels.

## Local Additions

Adds `/boomerang:commit [args]`, a local shortcut that sends plain `commit [args]` to boomerang while injecting `git-master`.