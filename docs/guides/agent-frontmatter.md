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
extensions: |
  +better-bash-tool, +rtk, +direnv, +filter-outputs,
  +codegraph, +lsp
tools: |
  +@all,
  -@builtin, +read, +bash, +edit, +write
prompt_mode: system_instructions
---

<system prompt body — the agent's behavioral contract>
```

The body becomes the agent/mode system prompt (trimmed). A mode with an **empty
body, a missing file, or an invalid file runs with no prompt and no tools**; an
invalid file's errors are shown as notifications
([`config-loader.ts`](../../extensions/modes/src/config-loader.ts)).

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

- `extensions` and `tools` are signed rule lists; see [Access rules](#access-rules).
- Boolean flags are strict: only the literal `true` enables them.

Fields whose purpose the code does not make obvious:

- `description` — shown in the Agent picker and used by orchestrators to route. **Write this well** — it is the routing signal.
- `extensions` — which extensions load (Subagents only). Loading an extension grants none of its tools.
- `tools` — which tools the agent may see and call.
- `discover_skills` — whether pi's skill **catalog** is discoverable on demand.
- `preload_skills` — skill names whose full body is injected into the system prompt. Independent of `discover_skills`.
- `isolated` — no extensions load, so only granted built-in tools remain.

> **Not a frontmatter field:** `thinking`. Per-call `thinking`, `model`, and
> `max_turns` are also **`agent` tool invocation parameters**; frontmatter sets
> the defaults, the tool call can override. Thinking level for the frontmatter
> `model` is expressed as a suffix in the model spec (`:high`, `:xhigh`), not a
> separate key.

---

## Mode frontmatter

A mode file uses the **same parser**, but `parseModeAgentConfig` reads only
`tools`, the delegation fields, `allow_nesting`, `prompt_mode`, and `model`.
Mode-specific differences:

- `prompt_mode` collapses `system_instructions` to `replace`, and does **not** control AGENTS.md injection — modes always run with project AGENTS.md present.
- `model` is overridable per session with `/mode-model`.
- `extensions` is an error: the main session cannot unload an extension.
- A mode file without `tools` grants no tools.

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

## Access rules

`extensions` and `tools` are ordered lists of signed rules.
[`active-tools.ts`](../../extensions/lib/active-tools.ts) owns parsing
(`parseAccessRules`) and evaluation (`resolveExtensionAccess`, `resolveToolAccess`).

- Every entry is `+selector` or `-selector`. The sign is required; it also keeps `@` and `*` entries valid YAML.
- Lists start empty. Rules apply left to right, and the last matching rule wins; a candidate no rule matches is excluded.
- An omitted or empty field means nothing: no extensions load, no tools are granted.
- `tools` grants permission, not activation. Pi turns tools on (on registration unless the tool sets `defaultActive: false`, plus the `defaultTools` setting), and the owning extension turns its own tools on and off through commands or loaders such as `web_enable`. A rule cannot turn on a default-off tool; add it to `defaultTools`.
- Values may be a comma-separated string or a YAML list:

```yaml
tools: +read, +bash, +@codegraph, +lsp
```

```yaml
tools:
  - +read
  - +@pi-web-access
  - -source_check
```

### Layout

Write a `tools:` value that does not fit one line as a `|` block with one group per line:

```yaml
tools: |
  +@all,
  -@builtin, +read, +bash, +edit, +write, -tool_search,
  -@pi-intercom, -@pi-web-access, +web_enable, -@imagegen
```

- Line 1: `+@all` alone, when the list starts from every tool.
- Line 2: built-in rules: `@builtin` with its exceptions, plus Pi built-in extension tools such as `codemode` and `tool_search`.
- Remaining lines: extension rules, wrapped at about 80 columns.
- Subagent `extensions:` follow the same order: Pi built-in extensions such as `+builtin:codemode`, then the bash stack and `filter-outputs`, then tool providers.
- Keep a group rule next to its exceptions, e.g. `-@pi-web-access, +web_enable`.
- Separate rules with commas, including at line ends; whitespace alone is not a separator.

### `extensions` selectors (Subagents only)

| Selector | Matches |
|---|---|
| `@all` | Discovered extensions plus Pi built-in extensions |
| `@builtin` | Pi built-in extensions; same as `builtin:*` |
| `<id>` | One extension: `builtin:<name>`, or the extension's directory name or package short name |
| glob | `*` matches any characters, e.g. `builtin:*` |

```yaml
extensions: +builtin:codemode, +better-bash-tool, +codegraph, +lsp
```

### `tools` selectors

| Selector | Matches |
|---|---|
| `@all` | Every registered tool |
| `@builtin` | Pi built-in tool names ([`BUILTIN_TOOL_NAMES`](../../extensions/lib/active-tools.ts)), whichever extension implements them |
| `@<id>` | Tools registered by that extension, excluding built-in tool names, e.g. `@codegraph`, `@builtin:codemode` |
| name | A Pi tool name, e.g. `read`, `codemode` |
| glob | `*` matches any characters, e.g. `codegraph_*`, `mcp__ctx__*` |

MCP tools are named `mcp__<server>__<tool>`, with every character outside `[A-Za-z0-9_]` mapped to `_` (server `open-design` → `mcp__open_design__*`).

```yaml
tools: +@all, -@builtin, +read, +bash, +edit, +write, -web_enable
```

Extension groups and globs are evaluated against the live tool registry, so a
tool registered later by a granted extension is granted too.

### Loading and granting

- Loading an extension grants nothing; `tools` alone grants. An extension that did not load contributes no tools.
- Built-in tools are grantable without loading any extension.
- Pi's built-in codemode loads only through `extensions` (`+builtin:codemode`).
- `isolated: true` loads no extensions, so only granted built-in tools remain.

### Hard gates

After the rules apply:

- tools from trusted internal sources (`<inline:…>`, `<sdk:…>`) are always allowed;
- nested subagent controls (`agent`, `get_agent_result`, `resolve_agent_graph_gate`, `steer_subagent`) require `allow_nesting: true`;
- goal tools require Goal access;
- plan tools are granted only in Fu Xi.

`+@all` therefore cannot enable recursion or plan-only tools.

### Diagnostics

Errors make the definition invalid; warnings do not.

- **Errors:** an unsigned entry; an unknown `@word`; reserved words (`@read`, `@write`, `@package`, `@project`, `@user`, `@mcp:*`, argument parentheses); a path, bare `all`, or bare `builtin` in `extensions`; an extension id matching more than one extension; an extension id colliding with a reserved word; `extensions` in a mode file.
- **Warnings:** an extension id or `@<id>` group that matches nothing; a leading `-` rule, which does nothing on an empty start.
- Tool names and globs that match nothing never warn, because some tools register only in some configurations.

### Enforcement

The granted set is a ceiling: ungranted tools are hidden from the model and
every call to them is blocked, top-level and nested inside codemode.

- **Modes** gate permission only; `tools:` never activates a tool. Pi and owning extensions decide what's active (registration, `defaultTools`, extension loaders). The always-active, model-only `mode_tool_ceiling` tool hides declared-but-unpermitted tools after all `before_agent_start` handlers, and a `tool_call` guard vetoes every unpermitted call, top-level and nested. There is no per-turn pruning of the active set.
- **Subagents** see only granted tools from the first turn. See the [subagents README](../../extensions/subagents/README.md#tool--extension-scoping).
- The codemode and `tool_search` catalogs may still list ungranted codemode or deferred tools; only the call veto stops them.

### Role guidance

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
- Delegation also requires the nested subagent tools: granted in `tools` and
  enabled by `allow_nesting: true`.
- Subagent sessions never receive the nested subagent tools: the runner excludes
  them ([`agent-runner.ts`](../../extensions/subagents/src/agent-runner.ts)), so
  subagents cannot delegate and these fields take effect only in modes.

For modes, delegation frontmatter is canonically parsed into a versioned policy
snapshot persisted in `agent-mode` state, which the subagent extension consumes as
the authorization authority (see
[`docs/specs/mode-scoped-subagent-delegation.md`](../specs/mode-scoped-subagent-delegation.md)).

---

## Invalid / obsolete fields

These fields make a definition **invalid** — the loader emits an error
diagnostic with a rewrite hint and skips the agent; a mode with one runs with no
prompt and no tools and shows the errors as notifications:

- `builtin_tools`, `extension_tools` → `tools` rules.
- `exclude_extensions`, `inherit_extensions`, boolean `extensions` → `extensions` rules.
- `disallowed_tools`, `disallow_tools` → a `-name` rule in `tools`.
- `skills`, `inherit_skills` → split into `discover_skills` (catalog on/off) and
  `preload_skills` (eager-inject names).

---

## Worked examples

### Read-only consultant (subagent)

```yaml
---
display_name: Taishang 太上老君
description: Architecture decisions and debugging. Read-only consultation with deep analysis.
model: anthropic/claude-opus-4-8:xhigh,openai-codex/gpt-5.6-sol:high
discover_skills: false
extensions: |
  +better-bash-tool, +rtk, +direnv, +filter-outputs,
  +codegraph, +lsp, +multimodal-look
tools: |
  +@all,
  -@builtin, +read, +bash
---
```

The loaded extensions decide the extension tools; the built-in line keeps `edit`/`write` out. Built-in `bash` is guarded by the trusted hidden `smart-tool-guards` subagent factory.

### Implementation worker (subagent)

```yaml
---
display_name: Jintong 金童
description: A focused build worker for isolated implementation, debugging, and verification tasks.
model: claude-sonnet-4-6,openai-codex/gpt-5.5:medium
prompt_mode: system_instructions
extensions: |
  +builtin:codemode,
  +better-bash-tool, +rtk, +direnv, +filter-outputs,
  +codegraph, +lsp
tools: |
  +@all,
  -@builtin, +read, +bash, +edit, +write
---
```

`system_instructions` gives its own persona while inheriting AGENTS.md guardrails.
Full mutating built-ins for implementation work; codemode is loaded through
`extensions` and granted through `tools`.

### Orchestration mode

```yaml
---
display_name: Kua Fu 夸父
description: Default build mode. A senior engineer who ships by orchestrating specialists.
model: anthropic/claude-opus-4-8:xhigh,openai-codex/gpt-5.6-sol:medium
inherit_context: false
tools: |
  +@all,
  -@builtin, +read, +bash, +edit, +write, -tool_search
allow_delegation_to: chengfeng,wenchang,xuannv,jintong,juling,yunu,guangguang,taishang,direnjie
allow_nesting: true
---
```

`+@all` grants every registered tool except the subtracted ones, and `allow_nesting: true`
lets the nested subagent tools through the hard gate, enabling delegation. `display_name`/`inherit_context` here are informational — the mode label
comes from `MODE_META` and `inherit_context` is inert for modes.

---

## Verification

There is no repo-local automated validator for agent/mode markdown. After editing:

1. Re-read the changed frontmatter and body for internal consistency.
2. Confirm no obsolete fields remain (see [Invalid / obsolete fields](#invalid--obsolete-fields)).
3. Confirm tool access matches role scope (read-only agents get no mutating tools).
4. For subagents, test by launching through the `agent` tool.
5. For modes, exercise the relevant integration coverage
   (`pnpm test:integration` or the focused mode test) for runtime-sensitive changes.
