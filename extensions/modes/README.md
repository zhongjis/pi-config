# modes

Agent modes extension with three personas — switch behavior, prompt, and tool sets per mode.

## What It Does

Three modes with distinct agent personas:

| Mode | Alias | Description |
|------|-------|-------------|
| Kua Fu 夸父 | `build` | Default. Senior engineer who ships by orchestrating specialists. |
| Fu Xi 伏羲 | `plan` | Planning and decomposition. Drafts plans with gap review. |
| Hou Tu 后土 | `execute` | Focused execution worker. Runs plans step by step. |

Each mode reads its prompt from `agents/<mode>.md`. Global AGENTS.md rules stay active in all modes.

### Plan flow (Fu Xi mode)

1. Fu Xi drafts a plan with Di Renjie gap review
2. `plan_approve` tool presents choices: Approve, High Accuracy Review (Yan Luo), Refine
3. Approved plan prepares Hou Tu handoff via `/handoff:start-work`

## Tools

### `plan_approve`

Present the plan approval menu after plan generation is complete.

**Parameters:**
- `variant` (optional): `"post-gap-review"` (default, includes High Accuracy Review option) or `"post-high-accuracy"` (after Yan Luo already approved)

## Commands

- `/mode [kuafu|fuxi|houtu|build|plan|execute]` — Switch agent mode
- Tab / Ctrl+Shift+M — Cycle modes
- `--mode <name>` flag on session start

## Hooks

- `session_start`, `session_tree` — Restore mode state
- `before_agent_start` — Inject mode-specific prompt
- `input` — Handle mode switching keywords
- Status bar shows current mode with color coding

## Files Worth Reading

- `src/index.ts` — Extension entry, plan_approve tool registration
- `src/hooks.ts` — Lifecycle hooks and prompt injection
- `src/commands.ts` — Mode switching commands
- `src/mode-state.ts` — Mode state management and persistence
- `src/plan-approval.ts` — Plan review approval flow
- `src/constants.ts` — Mode definitions, aliases, colors
- `src/types.ts` — Type definitions
