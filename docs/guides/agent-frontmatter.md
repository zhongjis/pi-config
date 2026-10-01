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

## Fields

[`extensions/lib/agent-frontmatter.ts`](../../extensions/lib/agent-frontmatter.ts)
defines every field, its value format, and its default. Only include fields that
differ from the default. Parsing rules worth knowing while authoring:

- List fields take CSV strings; `none` is an explicit empty list, distinct from omitting the field.
- Boolean flags are strict: only the literal `true` enables them.
- `extension_tools` accepts trailing `*` prefix wildcards (`codegraph_*`).

Fields whose purpose the code does not make obvious:

- `description` — shown in the Agent picker and used by orchestrators to route. **Write this well** — it is the routing signal.
- `extensions` — which extensions load (`false` loads none). A CSV value counts as enabled and keeps only the named or path-listed extensions; it does not scope tools to those sources. Use `extension_tools` for per-tool reachability and `exclude_extensions` for per-source exclusion.
- `discover_skills` — whether pi's skill **catalog** is discoverable on demand.
- `preload_skills` — skill names whose full body is injected into the system prompt. Independent of `discover_skills`.
- `isolated` — built-ins only; overrides `extensions`/`extension_tools`.

> **Not a frontmatter field:** `thinking`. Per-call `thinking`, `model`, and
> `max_turns` are also **`agent` tool invocation parameters**; frontmatter sets
> the defaults, the tool call can override. Thinking level for the frontmatter
> `model` is expressed as a suffix in the model spec (`:high`, `:xhigh`), not a
> separate key.

---

## Mode frontmatter

A mode file uses the **same parser**, but `parseModeAgentConfig` reads only the
tool-selection, delegation, `allow_nesting`, `prompt_mode`, and `model` fields.
Mode-specific differences:

- `prompt_mode` collapses `system_instructions` to `replace`, and does **not** control AGENTS.md injection — modes always run with project AGENTS.md present.
- `model` is overridable per session with `/mode-model`.

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

1. **`builtin_tools`** — granted only within the built-in universe
   (`read, bash, edit, write, grep, find, ls`). Subagents report other names as
   unknown built-ins; they are never granted.
2. **`extensions`** — `false` makes every extension tool unreachable.
3. **`extension_tools`** — post-load allowlist deciding which extension tools are
   reachable. `undefined` = all available; `false`/`none` = none; a list = exact
   names or `prefix*` wildcards.
4. **`allow_nesting`** — nested controls (`agent`, `get_agent_result`,
   `resolve_agent_graph_gate`, `steer_subagent`) are unreachable unless this is `true`.

Reachable tools activate by Pi tool exposure: `direct` and `model-only` tools
activate; `codemode` and `deferred` tools stay reachable from codemode scripts but
are never auto-activated (one already active stays active); `hidden` tools never
activate. Nested calls from codemode scripts are blocked for unreachable tools in
subagents and in modes with a tool policy; Fu Xi's plan tools stay reachable in `fuxi`.

Precedence and rules:

- `isolated: true` disables **all** extension tools regardless of
  `extensions`/`extension_tools`.
- `extension_tools` can never grant built-ins.
- Subagents load Pi's built-in codemode (`builtin:codemode`, with the script
  `models` catalog disabled) only for an exact `codemode` entry in
  `extension_tools`; omitted lists and wildcards never load it. It does not load
  under `isolated: true` or `extensions: false` (a diagnostic reports the
  listing). `exclude_extensions: builtin:codemode` or the Pi settings entry
  `-builtin:codemode` disables it; a CSV `extensions` value does not.
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
mode or agent may spawn through the `agent` tool.

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

The following obsolete fields make a definition **invalid** — the loader emits an
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
extension_tools: ask,agent,get_agent_result,steer_subagent,Task*,codegraph_*,context_*,process,lsp,create_goal,get_goal,update_goal
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
4. For subagents, test by launching through the `agent` tool.
5. For modes, exercise the relevant integration coverage
   (`pnpm test:integration` or the focused mode test) for runtime-sensitive changes.
