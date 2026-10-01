# modes

Agent modes extension with three personas — switch behavior, prompt, and tool sets per mode.

## What It Does

Three modes with distinct agent personas:

| Mode | Alias | Description |
|------|-------|-------------|
| Kua Fu 夸父 | `build` | Default. Senior engineer who ships by orchestrating specialists. |
| Fu Xi 伏羲 | `plan` | Planning and decomposition. Drafts plans with gap review. |
| Hou Tu 后土 | `execute` | Focused execution worker. Runs plans step by step. |

Saved modes that are unknown or malformed fall back to clean `kuafu`, discarding their model override and planning/review state. Valid saved state still restores when `--mode` is absent or explicitly `kuafu`; other CLI values retain their existing precedence.

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

Configured model chains (or the active `/mode-model` override) use the shared
[post-native-retry continuation contract](../../docs/specs/model-selection-and-fallback.md#post-native-retry-chain-continuation).

## Entry Points

- `/mode [kuafu|fuxi|houtu|build|plan|execute]` or `--mode <name>` — switch mode; Tab / Ctrl+Shift+M cycle modes.
- `/mode-model` — show, set (`<provider/modelId>`), or `--reset` the session-scoped model override.
- `plan_approve` and `plan_scaffold` — Fu Xi planning tools.

[src/commands.ts](src/commands.ts) registers the commands and [src/index.ts](src/index.ts) registers the planning tools and hooks. Mode changes that touch mode-owned skill resources reload the terminal; prompt args on those transitions do not auto-run, so resubmit after reload.

## Model Override

Each mode selects its model from the `model` frontmatter chain in `modes/<mode>/mode.md`. A `/mode-model` override, or a manual model or thinking-level pick mid-session, persists in the session, survives `/reload`, and wins over the frontmatter until `/mode-model --reset`. It never rewrites frontmatter.

### Fast defaults

Model candidates accept `provider/model[:thinking]:fast`, for example `anthropic/claude-opus-4-7:high:fast`. Only the selected available candidate determines the default; no suffix means off. Unsupported explicit fast fails before applying the model or committing a mode switch, rather than trying the next candidate for speed support.

Defaults live in the current session branch; explicit `/fast` preferences are session-wide. The latest user setting wins, including off, across prompts, retries, compaction, history navigation, reload, and reopening the same persisted session. Mode transitions, `/mode-model` override/reset, and runtime fallback update the effective candidate's default without overriding that preference. Defaults apply only when no explicit preference exists; new sessions use their configured mode default.

The [Fast extension](../fast/README.md) applies defaults using [strict request helpers](../lib/README.md#fast-request-helpers).
