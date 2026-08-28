# Agent and Mode Frontmatter Guide

Practical reference for authoring the YAML frontmatter that configures **subagents**
(`agents/*.md`) and **mode personas** (`modes/<mode>/mode.md`).

Both file types are parsed by one shared schema in
[`extensions/lib/agent-frontmatter.ts`](../../extensions/lib/agent-frontmatter.ts),
but each consumer reads a different subset of the parsed result:

- **Subagents** — loaded by [`extensions/subagents/src/custom-agents.ts`](../../extensions/subagents/src/custom-agents.ts).
  Consume the full field set.
- **Modes** — loaded by [`extensions/modes/src/config-loader.ts`](../../extensions/modes/src/config-loader.ts)
  via `parseModeAgentConfig`. Consume a **subset**; other fields are inert.

For the runtime behavior these fields drive, see
[`docs/specs/modes.md`](../specs/modes.md) and
[`docs/specs/mode-scoped-subagent-delegation.md`](../specs/mode-scoped-subagent-delegation.md).

---

## File anatomy

Every agent/mode file is YAML frontmatter between `---` fences, followed by the
markdown prompt body:

```markdown
---
display_name: Example 示例
description: One-line description shown in the Agent picker.
model: anthropic/claude-sonnet-4-6:medium
builtin_tools: read,bash,edit,write
extension_tools: codegraph_*,lsp
prompt_mode: system_instructions
---

<system prompt body — the agent's behavioral contract>
```

The body becomes the agent/mode system prompt (trimmed). An **empty body makes a
mode config invalid** (`parseModeAgentConfig` returns `null`).

### Where files live

| Type | Repo source | Installed / runtime path | Discovery |
|------|-------------|--------------------------|-----------|
| Subagent | `agents/<name>.md` | `~/.pi/agent/agents/<name>.md` | Global `$PI_CODING_AGENT_DIR/agents/*.md` (default `~/.pi/agent/agents/`) + project `<cwd>/.pi/agents/*.md`. Project overrides global by name. `AGENTS.md` is skipped. |
| Mode | `modes/<mode>/mode.md` | `~/.pi/agent/modes/<mode>/mode.md` | Loaded per active mode from `~/.pi/agent/modes/<mode>/`. |

`install.sh` symlinks the `agents/` and `modes/` directories into `~/.pi/agent/`.

---

## Value formats (shared parser)

The parser normalizes values consistently across all fields:

| Format | Meaning | Examples |
|--------|---------|----------|
| CSV string | Comma-separated list, trimmed, empties dropped | `read,bash,edit` |
| `none` | Explicit empty list (distinct from omitting) | `extension_tools: none` |
| `true` / omitted | Inherit-all | `extensions: true` |
| `false` / `none` | Inherit-nothing | `extensions: false` |
| Boolean | `true` only; anything else is falsy | `allow_nesting: true` |
| Wildcard | Trailing `_*` / `*` prefix match (extension tools only) | `codegraph_*` |

Booleans are strict: for `allow_nesting`, `inherit_context`, `run_in_background`,
`isolated`, only the literal `true` enables the flag.

---

## Subagent frontmatter fields

Consumed by the subagent extension. Only include fields that differ from the default.

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `description` | string | agent name | One-line summary shown in the Agent picker and used by orchestrators to route. **Write this well** — it is the routing signal. |
| `display_name` | string | — | Human label shown in UI (e.g. `Taishang 太上老君`). |
| `model` | string | inherit parent | Model fallback chain (see [Model chain](#model-chain-and-thinking-level)). |
| `builtin_tools` | CSV of built-ins \| `none` | all built-ins | Allowlist from `read, bash, edit, write, grep, find, ls`. Names outside this set are never granted. `none` = no built-ins. |
| `extension_tools` | CSV / wildcards \| `none` | all available | Exact extension/MCP tool allowlist after extensions load. Supports `foo_*` prefix wildcards. `none` = no extension tools. Cannot grant built-ins. |
| `extensions` | `true` \| `false`/`none` \| CSV | `true` | Whether extension/MCP tools are available at all. `false`/`none` disables them. A **CSV value is currently treated as "enabled" (equivalent to `true`)** at the active-tool layer — it does not scope tools to those sources. Use `extension_tools` for per-tool filtering and `exclude_extensions` for per-source exclusion. (`inherit_extensions` is an accepted alias.) |
| `exclude_extensions` | CSV | — | Extension source names to exclude. |
| `discover_skills` | boolean | `true` | Whether pi's skill **catalog** is discoverable on demand (drives runtime `noSkills = !discover_skills`). `false`/`none` disables the catalog. |
| `preload_skills` | CSV \| `none` | — | Skill names whose full body is eagerly injected into the system prompt (via `preloadSkills()` → `skillBlocks`). Independent of `discover_skills` — the catalog can be on while some skills are preloaded. |
| `prompt_mode` | `replace` \| `append` \| `system_instructions` | `replace` | How the body forms the system prompt (see [prompt_mode](#prompt_mode)). |
| `allow_delegation_to` | CSV | unrestricted | Agent names this agent may spawn via `Agent`. |
| `disallow_delegation_to` | CSV | — | Agent names this agent may not spawn. Applied as exclusions after `allow_delegation_to`. |
| `allow_nesting` | boolean | `false` | Permit nested subagent tools (`Agent`, `get_subagent_result`, `steer_subagent`) — only if also allowed by tool policy. |
| `inherit_context` | boolean | `false` | Fork the parent conversation into the agent so it sees chat history. |
| `run_in_background` | boolean | `false` | Run in background by default. |
| `isolated` | boolean | `false` | No extension/MCP tools at all — built-ins only. Overrides `extensions`/`extension_tools`. |
| `max_turns` | non-negative int | unlimited | Cap on agentic turns. `0` or omit = unlimited. |
| `enabled` | boolean | `true` | Set `enabled: false` to disable the agent definition. |

> **Not a frontmatter field:** `thinking`. Per-call `thinking`, `model`, and
> `max_turns` are also **`Agent` tool invocation parameters**; frontmatter sets
> the defaults, the tool call can override. Thinking level for the frontmatter
> `model` is expressed as a suffix in the model spec (`:high`, `:xhigh`), not a
> separate key.

---

## Mode frontmatter fields

A mode file uses the **same parser**, but `parseModeAgentConfig` reads only these:

| Field | Type | Notes |
|-------|------|-------|
| `prompt_mode` | `append` \| everything-else→`replace` | Modes collapse `system_instructions` to `replace`. Mode `prompt_mode` does **not** control AGENTS.md injection — modes always run with project AGENTS.md present. |
| `builtin_tools` | CSV \| `none` | Only applied when a tool-selection field is present (see below). |
| `extension_tools` | CSV / wildcards \| `none` | Post-load extension-tool filter. |
| `extensions` | `true` \| `false`/`none` \| CSV | Extension availability. A CSV value is treated as "enabled" (equivalent to `true`) at the active-tool layer, not a source scope. |
| `allow_delegation_to` | CSV | Subagent types this mode may delegate to. |
| `disallow_delegation_to` | CSV | Blocklist, applied as exclusions from `allow_delegation_to`. |
| `allow_nesting` | boolean | Permit nested subagent tools. |
| `model` | string | Mode model fallback chain. Overridable per-session with `/mode-model`. |

**Tool-selection gating.** `builtin_tools`, `extension_tools`, and `extensions`
are applied only when at least one tool-selection field
(`builtin_tools`, `extension_tools`, `extensions`, `inherit_extensions`,
`exclude_extensions`) is present. Omit them all and the mode inherits the runtime
default tool set instead of an empty one.

### Inert-for-modes fields

These commonly appear in `mode.md` frontmatter for parity/documentation but are
**not consumed** by the modes loader:

- `display_name`, `description` — the mode label comes from `MODE_META` in
  [`extensions/modes/src/constants.ts`](../../extensions/modes/src/constants.ts),
  not the frontmatter.
- `inherit_context`, `run_in_background`, `isolated`, `max_turns`,
  `discover_skills`, `preload_skills`, `enabled` — ignored by `parseModeAgentConfig`.

Mode-scoped skills are handled separately through `<mode>/skills/*/SKILL.md`
(see [`modes/AGENTS.md`](../../modes/AGENTS.md)), not the `discover_skills`/`preload_skills` frontmatter keys.

### Mode prompt variant files

A mode directory holds a matrix of prompt files by model family:

| File | Role |
|------|------|
| `mode.md` | Canonical frontmatter **plus** the default prompt body. Frontmatter lives **only** here. |
| `gpt.md` | Body-only replacement for GPT-family models. Inherits `mode.md` frontmatter; must be self-contained. |
| `gemini.md` | Body-only corrective overlay appended for Gemini-family models. |

`gpt.md` and `gemini.md` have **no frontmatter** — the loader reads them as raw
body text and reuses `mode.md`'s parsed config. Family is detected at runtime from
the active model id.

---

## prompt_mode

`prompt_mode` decides how the body becomes the system prompt.

| Value | Subagent behavior | Mode behavior |
|-------|-------------------|---------------|
| `replace` (default) | Body **is** the full system prompt. No parent identity, no AGENTS.md. | Strips previous mode bodies, then injects this body. |
| `append` | Body appended to the parent system prompt (parent identity **and** AGENTS.md preserved). | Injects body without stripping prior mode bodies. |
| `system_instructions` | Body is the full system prompt (no parent identity bleed), but pi auto-injects AGENTS.md as a `# Project Context` block after the body. | Coerced to `replace`. |

Guidance for subagents:

- `replace` — fully custom agents with their own personality and zero parent context.
- `append` — keep the parent/default prompt and add specialization on top.
- `system_instructions` — own personality with **no** parent identity bleed, but
  still inherit project AGENTS.md guardrails. **Recommended for implementation/edit workers**
  (e.g. `jintong`, `juling`, `guangguang`, `yunu`).

---

## Tool selection model

Final active tools are computed by
[`computeActiveToolNames`](../../extensions/lib/active-tools.ts) from four inputs:

1. **`builtin_tools`** — filtered against the built-in universe
   (`read, bash, edit, write, grep, find, ls`). Values outside it are dropped.
2. **`extensions`** — master switch for extension/MCP tools. `false` disables all.
3. **`extension_tools`** — post-load allowlist. `undefined` = all available;
   `false`/`none` = none; a list = exact names or `prefix*` wildcards.
4. **`allow_nesting`** — nested subagent tools (`Agent`, `get_subagent_result`,
   `steer_subagent`) are removed unless this is `true`.

Precedence and rules:

- `isolated: true` disables **all** extension tools regardless of
  `extensions`/`extension_tools`.
- `extension_tools` can never grant built-ins.
- Read-only recon agents may receive built-in `bash` only when a trusted runtime guard scopes it to read-only actions; they still receive no `edit`/`write`
  (see [`agents/AGENTS.md`](../../agents/AGENTS.md) and [`extensions/smart-tool-guards/README.md`](../../extensions/smart-tool-guards/README.md)).
- Prefer `bash` with `rg`/`fd` over the `grep`/`find`/`ls` built-ins.

Tool-intelligence split to reflect in prompts and allowlists:

- `codegraph_*` — broad structure, call flow, impact, architecture.
- `lsp` — symbol-precise facts and diagnostics.
- `rg`/`fd` (via `bash`) — literal text and file search.

---

## Model chain and thinking level

`model` is a **fallback chain**: comma-separated `provider/modelId[:thinkingLevel]`
entries; the first available match wins.

```yaml
model: anthropic/claude-opus-4-8:xhigh,openai-codex/gpt-5.6-sol:high,opencode-go/deepseek-v4-pro:medium,llama-swap/qwen2.5-coder:14b:medium
```

- Thinking level is the `:level` suffix: `none`, `minimal`, `low`, `medium`,
  `high`, `xhigh`.
- Omit `model` on a subagent to inherit the parent model.
- Bare or fuzzy model names (no `provider/` prefix, e.g. `claude-sonnet-4-6`) are
  also accepted and resolved against the model registry.
- For modes, `/mode-model <spec>` sets a session-scoped override that takes
  precedence over this chain; `/mode-model --reset` restores it.

See [`docs/specs/model-selection-and-fallback.md`](../specs/model-selection-and-fallback.md)
for chain resolution and fallback semantics.

---

## Delegation fields

`allow_delegation_to` / `disallow_delegation_to` govern which agent types a
mode or agent may spawn through the `Agent` tool.

- The **allowlist is applied first**, then `disallow_delegation_to` removes entries
  from that set.
- Blocked delegations return a descriptive reason listing permitted targets.
- Delegation also requires the nested subagent tools to be active
  (`allow_nesting: true` + tool policy).

For modes, delegation frontmatter is canonically parsed into a versioned policy
snapshot persisted in `agent-mode` state, which the subagent extension consumes as
the authorization authority (see
[`docs/specs/mode-scoped-subagent-delegation.md`](../specs/mode-scoped-subagent-delegation.md)).

---

## Invalid / obsolete fields

The following legacy fields make a definition **invalid** — the loader emits an
error diagnostic and skips the agent, and a mode config becomes `null`:

- `tools` → use `builtin_tools` + `extension_tools` instead.
- `disallowed_tools`, `disallow_tools` → no denylist exists; use explicit
  `builtin_tools`/`extension_tools` allowlists.
- `skills`, `inherit_skills` → split into `discover_skills` (catalog on/off) and
  `preload_skills` (eager-inject names).

There is intentionally **no tool denylist**. Tool selection is allowlist-only.

---

## Worked examples

### Read-only consultant (subagent)

```yaml
---
display_name: Taishang 太上老君
description: Architecture decisions and debugging. Read-only consultation with deep analysis.
model: anthropic/claude-opus-4-8:xhigh,openai-codex/gpt-5.6-sol:high
discover_skills: false
builtin_tools: read,bash
extension_tools: look_at,codegraph_*,lsp
extensions: true
---
```

No `edit`/`write`; built-in `bash` is guarded by the trusted hidden `smart-tool-guards` subagent factory.

### Implementation worker (subagent)

```yaml
---
display_name: Jintong 金童
description: A focused build worker for isolated implementation, debugging, and verification tasks.
model: claude-sonnet-4-6,openai-codex/gpt-5.5:medium
prompt_mode: system_instructions
builtin_tools: read,bash,edit,write
extension_tools: codegraph_*,lsp
---
```

`system_instructions` gives its own persona while inheriting AGENTS.md guardrails.
Full mutating built-ins for implementation work.

### Orchestration mode

```yaml
---
display_name: Kua Fu 夸父
description: Default build mode. A senior engineer who ships by orchestrating specialists.
model: anthropic/claude-opus-4-8:xhigh,openai-codex/gpt-5.6-sol:medium
inherit_context: false
builtin_tools: read,bash,edit,write
extension_tools: ask,Agent,get_subagent_result,steer_subagent,Task*,codegraph_*,context_*,process,lsp,create_goal,get_goal,update_goal
allow_delegation_to: chengfeng,wenchang,xuannv,jintong,juling,yunu,guangguang,taishang,direnjie
disallow_delegation_to: houtu
allow_nesting: true
---
```

`allow_nesting: true` plus the nested subagent tools in `extension_tools` enables
delegation. `disallow_delegation_to: houtu` is a defensive guard: since `houtu` is
not in this allowlist (and is a mode, not a delegable subagent), it removes nothing
here, but the allowlist-then-blocklist order means any overlapping entry would be
dropped. `display_name`/`inherit_context` here are informational — the mode label
comes from `MODE_META` and `inherit_context` is inert for modes.

---

## Verification

There is no repo-local automated validator for agent/mode markdown. After editing:

1. Re-read the changed frontmatter and body for internal consistency.
2. Confirm no obsolete fields (`tools`, `disallowed_tools`, `disallow_tools`, `skills`, `inherit_skills`) remain.
3. Confirm tool access matches role scope (read-only agents get no mutating tools).
4. For subagents, test by launching through the `Agent` tool.
5. For modes, exercise the relevant integration coverage
   (`pnpm test:integration` or the focused mode test) for runtime-sensitive changes.
