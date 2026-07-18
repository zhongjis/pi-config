# modes

Agent modes extension with five personas — switch behavior, prompt, and tool sets per mode.

## What It Does

Five modes with distinct agent personas:

| Mode | Alias | Description |
|------|-------|-------------|
| Kua Fu 夸父 | `build` | Default. Senior engineer who ships by orchestrating specialists. |
| Fu Xi 伏羲 | `plan` | Planning and decomposition. Drafts plans with gap review. |
| Hou Tu 后土 | `execute` | Focused execution worker. Runs plans step by step. |
| Lu Ban 鲁班 | — | Skill-first discipline mode adapted from obra/superpowers. |
| Shen Nong 神農 | `pm` | Product mode. Frames the problem, prioritizes, and de-risks; hands off to Kua Fu. |

Each mode reads its prompt from `modes/<mode>/mode.md`. Global AGENTS.md rules stay active in all modes.

### Plan flow (Fu Xi mode)

1. Fu Xi drafts a plan with Di Renjie gap review
2. `plan_approve` tool presents choices: Approve, High Accuracy Review (Yan Luo), Refine
3. Approved plan prepares Hou Tu handoff via `/handoff:start-work`


### Mode frontmatter

Mode prompts live in `modes/<mode>/mode.md` and use the shared agent frontmatter schema:

- `builtin_tools` — exact built-in allowlist (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`; `none` for none)
- `extensions` — extension availability/source scope; `false`/`none` disables extension tools
- `extension_tools` — extension-tool allowlist after extensions are available; exact names and trailing `*` prefix wildcards are supported; `none` disables extension tools
- `allow_nesting` — permits nested subagent tools only when those tools are also allowlisted
- `prompt_mode`, `model`, `allow_delegation_to`, `disallow_delegation_to` — same schema as custom subagents. Modes only honor `replace` (default; strips prior mode bodies before appending) and `append` (stacks); `system_instructions` is parsed but coerced to `replace` for modes.

Obsolete `tools`, `disallowed_tools`, and `disallow_tools` frontmatter is rejected.
## Tools

### `plan_approve`

Present the plan approval menu after plan generation is complete.

**Parameters:**
- `variant` (optional): `"post-gap-review"` (default, includes High Accuracy Review option) or `"post-high-accuracy"` (after Yan Luo already approved)

## Commands

- `/mode [kuafu|fuxi|houtu|luban|shennong|build|plan|execute]` — Switch agent mode
- `/mode-model` — Show or override the mode's model
- `/mode-model <provider/modelId>` — Set a session-scoped model override
- `/mode-model --reset` — Clear the model override and revert to mode's chain
- Tab / Ctrl+Shift+M — Cycle modes
- `--mode <name>` flag on session start

## Model Override

By default, each mode selects its model from the `model` frontmatter chain in `modes/<mode>/mode.md`. The `/mode-model` command lets you temporarily override this choice for the current session:

- `/mode-model` — Shows current mode, override (if any), configured fallback chain, and active model.
- `/mode-model anthropic/claude-sonnet-4:high` — Sets a session-scoped override. Validates the model exists in the registry before applying.
- `/mode-model --reset` — Clears the override and reverts to the mode's configured chain.

The override is persisted in the session JSONL and survives `/reload`. It does **not** change the mode's frontmatter — it's a runtime override only.

## Hooks

- `session_start`, `session_tree` — Restore mode state
- `before_agent_start` — Inject mode-specific prompt
- `model_select` — Re-apply mode model when session restores a saved model
- `resources_discover` — Expose Fu Xi or Luban mode-owned skills only while that mode is active
- `context`, `session_compact` — Eagerly inject and restore only the configured Fu Xi `ulw-plan` bootstrap; Luban relies on its mode prompt skill gate
- `input` — Handle mode switching keywords
- Status bar shows current mode with color coding

## Files Worth Reading

- `src/index.ts` — Extension entry, plan_approve tool registration
- `src/hooks.ts` — Lifecycle hooks and prompt injection
- `src/commands.ts` — Mode switching commands
- `src/mode-state.ts` — Mode state management and persistence
- `src/mode-skills.ts` — Active-mode skill discovery and explicit bootstrap configuration
- `src/plan-approval.ts` — Plan review approval flow
- `src/constants.ts` — Mode definitions, aliases, colors
- `src/types.ts` — Type definitions
