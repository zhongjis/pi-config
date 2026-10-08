# subagents

A [pi](https://pi.dev) extension that brings **Claude Code-style autonomous sub-agents** to pi. Spawn specialized agents that run in isolated sessions — each with its own tools, system prompt, model, and thinking level. Run them in foreground or background, steer them mid-run, resume completed sessions, and define your own custom agent types.

Agent descendants automatically share the parent Agent tree's `local://` storage root while retaining separate conversations, tools, and models.

## Attribution

Derived from [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) under the MIT license; see [LICENSE](LICENSE).

## Features

- **Agent supervision** — launch with `agent`, collect with `get_agent_result({run_id, wait:true})`, and redirect active workers with `steer_subagent`
- **Parallel background agents** — spawn multiple agents that run concurrently with automatic queuing (configurable concurrency limit, default 4) and smart group join (consolidated notifications)
- **Live widget UI** — persistent above-editor widget with animated spinners, live tool activity, token counts, and colored status icons. Configurable via `/agents → Settings → Widget`: `all` (every agent), `background` (default — hides foreground runs, which already render inline as the `agent` tool result), or `off`
- **FleetView** — Claude Code-style navigable list of `main` + every running subagent rendered below the editor (earliest-launched first). Press `↓` (or `←`) at an empty prompt to jump in, `↑`/`↓` to move the selection, `Enter` to open the selected agent's live, auto-updating conversation, `Esc` to return. Finished agents linger briefly before dropping out, and a viewer stays open through completion so you can read the final output. Toggle via `/agents → Settings → Fleet view`
- **Agent Monitor** — `/agent-monitor` opens a full-screen roster with two sections, agent graph runs and independent agents, including finished entries from this session. In-memory records last up to 30 minutes; independent `persist_session` runs also remain as read-only history after reload. `Enter` on a graph run opens the graph panel — the Herdr pane layout — inside Pi with `c` conversation, `p` pause/resume, `s` skip, `r` retry, and `x` stop; `Enter` on an agent opens its conversation. `o` detaches a graph run to a read-only Herdr side pane.
- **Conversation viewer** — select any agent in `/agents` to open a live-scrolling overlay of its full conversation (auto-follows new content, scroll up to pause). Steer a running agent inline by pressing `Enter` to open a composer, typing, then `Enter` to send (`Esc` or an empty submit returns) — the message appears as a user message and redirects the agent after its current tool. Stop a still-running agent by pressing `x` (then `x` again to confirm) — both work for background agents too. Press `/` to search the transcript (`n`/`N` for next/previous match, `Esc` clears), or `[`/`]` to jump between messages. Tool calls show their main argument, long results show their first and last lines with an omitted-line count, and assistant errors appear inline. Reload-surviving history rows in `/agent-monitor` open the same viewer read-only
- **Custom agent types** — define agents in `.pi/agents/<name>.md` or `.agents/agents/<name>.md` (project) or globally, with YAML frontmatter: custom system prompts, model selection, thinking levels, tool restrictions
- **Mid-run steering** — inject messages into running agents to redirect their work without restarting
- **Session resume** — pick up where an agent left off, preserving full conversation context. Terminal Agent records remain resumable for 30 minutes within the current parent session; session switch, reload, or shutdown may clean them sooner.
- **Graceful turn limits** — agents get a "wrap up" warning before hard abort, producing clean partial results instead of cut-off output
- **Case-insensitive agent types** — `"explore"`, `"Explore"`, `"EXPLORE"` all work. Unknown types fall back to general-purpose with a note
- **Fuzzy model selection** — specify models by name (`"haiku"`, `"sonnet"`) instead of full IDs, with automatic filtering to only available/configured models
- **Context inheritance** — optionally fork the parent conversation into a sub-agent so it knows what's been discussed
- **Persistent agent memory** — three scopes (project, local, user) with automatic read-only fallback for agents without write tools
- **Skill preloading** — inject named skills into agent system prompts, discovered from `.pi/skills/`, `.agents/skills/`, and global locations (Pi-standard `<name>/SKILL.md` directory layout supported)
- **Tool denylist** — block specific tools via `disallowed_tools` frontmatter
- **Styled completion notifications** — background agent results render as themed, compact notification boxes (icon, stats, result preview) instead of raw XML. Expandable to show full output. Group completions render each agent individually
- **Event bus** — lifecycle events (`subagents:created`, `started`, `completed`, `failed`, `steered`, `compacted`) emitted via `pi.events`, enabling other extensions to react to sub-agent activity
- **Cross-extension RPC** — other pi extensions can spawn and stop subagents via the `pi.events` event bus (`subagents:rpc:ping`, `subagents:rpc:spawn`, `subagents:rpc:stop`). Standardized reply envelopes with protocol versioning. Emits `subagents:ready` on session start
- **Schedule subagents** — pass `schedule` to the `agent` tool to fire on cron / interval / one-shot. Session-scoped jobs with PID-locked persistence; results land via the same `subagent-notification` followUp path as manual background completions; manage via `/agents → Scheduled jobs`
- **Model scope enforcement** — opt-in validation that subagent model choices stay within your pi `enabledModels` allowlist (sourced from `/scoped-models`, with both global and project-local pi settings honored). Caller-supplied out-of-scope → hard error to orchestrator; frontmatter-pinned out-of-scope → warning + runs anyway (frontmatter authoritative). Toggle via `/agents → Settings → Scope models`

## Install

This repository installs the extension through its root `install.sh`; see the root [README](../../README.md).

## Quick Start

The parent agent spawns sub-agents using the `agent` tool:

```
agent({
  subagent_type: "Explore",
  prompt: "Find all files that handle authentication",
  description: "Find auth files",
  run_in_background: true,
})
```

Foreground agents block until complete and return results inline. Background agents return an ID immediately and notify you on completion.

### Scheduling

Add a `schedule` field to register the agent to fire later instead of running now:

```
agent({
  subagent_type: "Explore",
  prompt: "Look at recent commits and summarize what changed since last week",
  description: "Weekly commit review",
  schedule: "0 0 9 * * 1",   // 9am every Monday (6-field cron)
})
```

Schedule formats:

- **Cron** — 6-field (`second minute hour day-of-month month day-of-week`), e.g. `"0 0 9 * * 1"` for 9am every Monday, `"0 */15 * * * *"` for every 15 minutes.
- **Interval** — `"5m"`, `"1h"`, `"30s"`, `"2d"`. Fires repeatedly at that interval.
- **One-shot relative** — `"+10m"`, `"+2h"`, `"+1d"`. Fires once at that future time.
- **One-shot absolute** — full ISO timestamp, e.g. `"2026-12-25T09:00:00.000Z"`.

When a schedule fires, the spawn runs in background and its completion notification arrives in the conversation through the same `subagent-notification` followUp path as a manually-spawned background agent — your parent agent reasons about the result the same way.

Schedules are **session-scoped**: they reset on `/new` and restore on `/resume`. List and cancel via `/agents → Scheduled jobs` (creation is the `agent` tool's job — there is no parallel manual-create wizard). Storage at `<cwd>/.pi/subagent-schedules/<sessionId>.json` with PID-based file locking for cross-instance safety.

**Disable the feature entirely**: `/agents → Settings → Scheduling → disabled` removes `schedule` from the `agent` tool spec (no LLM-context cost), hides the menu entry, and stops any active scheduler. The schema-level removal takes effect on the next pi session; the runtime kill is immediate. Re-enable from the same menu.

Restrictions:
- `schedule` cannot be combined with `inherit_context` (no parent conversation exists at fire time) or `resume` (schedules create fresh agents).
- `run_in_background` is forced to `true`.
- Scheduled fires bypass the `maxConcurrent` queue so a 5-minute interval cannot be deferred behind long-running manual agents.
- **Headless `pi -p` doesn't wait for scheduled subagents.**

## UI

The extension renders a persistent widget above the editor showing active agents. By default it shows background runs only (`widgetMode: background`) — foreground agents already render inline as the `agent` tool result, so the widget would otherwise double-render them. Switch to `all` (every agent) or `off` (hide the widget) via `/agents → Settings → Widget`:

```
● Agents
├─ ⠹ Agent  Refactor auth module · ↻5≤30 · 5 tool uses · 33.8k token (62%) · 12.3s
│    ⎿  editing 2 files…
├─ ⠹ Explore  Find auth files · ↻3 · 3 tool uses · 12.4k token (8%) · 4.1s
│    ⎿  searching…
├─ ⠹ Agent  Long-running task · ↻42 · 38 tool uses · 91.0k token (84% · ⇊2) · 2m17s
│    ⎿  reading…
└─ 2 queued
```

The token field is annotated with two optional signals inside parens:
- **`NN%`** — context-window utilization (color-coded: <70% dim, 70–85% warning, ≥85% error). Omitted when the model has no declared `contextWindow`, or briefly right after compaction.
- **`⇊N`** — number of times the session has compacted, when > 0. Stays dim; the percent's color carries urgency.

### FleetView

While subagents are running, a Claude Code-style navigable list renders **below** the editor:

```
  esc to interrupt · ← for agents · ↓ to manage

  ● main
  ○ general-purpose  Sleep then report 1                                11s · ↓ 13.1k tokens
  ○ general-purpose  Sleep then report 2                                11s · ↓ 13.1k tokens
                                                                                   ↓ 3 more
```

The list is ordered earliest-launched first, and only shows agents you can actually open (pending/queued agents with no session yet appear once they start). At an **empty prompt**, press `↓` (or `←`) to move focus from the prompt into the list — the selected row is marked `●`, the rest `○`. `↑`/`↓` move the selection, `Enter` opens the selected agent's live conversation overlay (it auto-updates as the agent works), and `Esc` (or `↑` above `main`) returns to the prompt. Selecting `main` returns to the normal view. Inside the overlay, press `Enter` to steer the running agent — type a message and `Enter` to send it (`Esc` or an empty submit returns), and it redirects the agent the same way the `steer_subagent` tool does. A viewer stays open when its agent finishes so you can read the final output, and finished agents linger in the list for a few seconds before dropping out. Typing anything at a non-empty prompt behaves normally — the list only captures arrow keys when the prompt is empty. Disable it entirely via `/agents → Settings → Fleet view`.

Agent and result-retrieval reports use at most three compact result rows, including the configured `app.tools.expand` hint:

```
▸ Agent · Health probe
├─ completed · HEALTH_OK chengfeng
├─ openai-codex/gpt-5.6-luna · thinking: medium
└─ ctrl+o to expand full result
```

Compact rows omit redundant status/result/activity/error labels and the model prefix; turns, soft limit, tools, tokens, and duration appear only expanded. Queued IDs/next actions and pending thinking remain available. Expansion shows the complete Markdown answer or error, then Run metadata (including zero tool uses), diagnostic warnings, and transcript artifacts; requested verbose conversation remains accessible. Legacy or malformed details use a compact raw preview and retain the complete raw body when expanded.

Model metadata is the actual SDK `provider/id`, even when identical to the parent. Thinking is the SDK's effective level, including clamping or `off`; queued/pre-session reports do not claim requested settings as actual. Expanded Run metadata discloses requested model/thinking when they differ from actual execution, with equivalent fuzzy model names kept quiet. Resume retains the original request and session rather than presenting resume-call overrides as applied. Optional estimated cost is also expanded-only; compact rows and model-visible result text remain unchanged. Resume uses the retained session rather than re-resolving changed spawn configuration. Turns and soft limit have separate labels; accumulated lifetime usage is labeled `tokens`, not context.

By default, foreground and background agents each stream their full conversation to a per-subagent transcript — a JSON-lines file at `<os-tmpdir>/pi-subagents-<uid>/<cwd>/<session>/tasks/<agent-id>.output` (owner-only `0700`, cleared on reboot). Set `output_transcript: false` on a custom agent to write no transcript path or file for it, or set `outputTranscript: false` in `subagents.json` to make transcripts opt-in for the whole project (frontmatter overrides the project default). This governs **only** the transcript: it is independent of `persist_session` (the pi session on disk) and `memory:` (durable files). Background agent completion notifications render as styled boxes:

```
✓ Find auth files completed
  ↻3 · 3 tool uses · 12.4k token · 4.1s
  ⎿  Found 5 files related to authentication...
  transcript: .pi/output/agent-abc123.jsonl
```

Group completions render each agent as a separate block. The LLM receives structured `<task-notification>` XML for parsing, while the user sees the themed visual.

## Default Agent Types

| Type | Tools | Model | Prompt Mode | Description |
|------|-------|-------|-------------|-------------|
| `general-purpose` | all 7 | inherit | `append` (parent twin) | Inherits the parent's full system prompt — same rules, CLAUDE.md, project conventions |
| `Explore` | read, bash, grep, find, ls | haiku (must be available) | `replace` (standalone) | Fast codebase exploration (read-only) |
| `Plan` | read, bash, grep, find, ls | inherit | `replace` (standalone) | Software architect for implementation planning (read-only) |

The `general-purpose` agent is a **parent twin** — it receives the parent's entire system prompt plus a sub-agent context bridge, so it follows the same rules the parent does. Explore and Plan use standalone prompts tailored to their read-only roles.

Default agents can be **ejected** (`/agents` → select agent → Eject) to export them as `.md` files for customization, **overridden** by creating a `.md` file with the same name (e.g. `.pi/agents/general-purpose.md`), or **disabled** per-project with `enabled: false` frontmatter.

## Custom Agents

Define custom agent types by creating `.md` files. The filename becomes the agent type name. Any name is allowed — using a default agent's name overrides it.

Agents are discovered from three locations (higher priority wins):

| Priority | Location | Scope |
|----------|----------|-------|
| 1 (highest) | `.pi/agents/<name>.md` | Project — pi's config dir; authoritative, and where `/agents` writes |
| 2 | `.agents/agents/<name>.md` | Project — the shared cross-tool `.agents` workspace (same convention as `.agents/skills/`) |
| 3 | `$PI_CODING_AGENT_DIR/agents/<name>.md` (default `~/.pi/agent/agents/<name>.md`) | Global — available everywhere |

Project-level agents override global ones with the same name, so you can customize a global agent for a specific project. If both project locations define the same name, **`.pi/agents/` wins** — `.pi` stays the project authority; `.agents/agents/` is an additional read location for projects that keep their agent assets in the `.agents` workspace. The global location follows Pi's `PI_CODING_AGENT_DIR` env var — set it to relocate all pi-coding-agent state (agents, skills, settings) to a custom directory.

### Example: `.pi/agents/auditor.md`

```markdown
---
description: Security Code Reviewer
tools: read, grep, find, bash
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
---

You are a security auditor. Review code for vulnerabilities including:
- Injection flaws (SQL, command, XSS)
- Authentication and authorization issues
- Sensitive data exposure
- Insecure configurations

Report findings with file paths, line numbers, severity, and remediation advice.
```

Then spawn it like any built-in type:

```
agent({ subagent_type: "auditor", prompt: "Review the auth module", description: "Security audit" })
```

### Frontmatter Fields

All fields are optional. [src/types.ts](src/types.ts) defines the fields and [../lib/agent-frontmatter.ts](../lib/agent-frontmatter.ts) parses them; the [agent frontmatter guide](../../docs/guides/agent-frontmatter.md) explains their use.

Frontmatter is authoritative. If an agent file sets `model`, `thinking`, `max_turns`, `inherit_context`, `run_in_background`, or `isolated`, those values are locked for that agent. `agent` tool parameters only fill fields the agent config leaves unspecified.

Model candidates accept `provider/model[:thinking]:fast`; no suffix means fixed off, never the parent's `/fast` toggle. Resume retains the selected setting. See [child policy contracts](MAINTENANCE.md#invocation-and-model-policy) for validation/isolation and [shared helpers](../lib/README.md#fast-request-helpers) for strict request mechanics.

Thinking precedence: agent frontmatter → selected model-chain suffix → SDK selected-model default. Omission never inherits parent thinking, even when the model is inherited, and `agent` tool calls carry no thinking value. The installed SDK resolves its native per-model/global/Pi defaults (per-model support depends on SDK version). Before session creation, Agent reports and queued retrieval display `thinking: default (pending)` only when the invocation retains omitted-thinking intent; unknown RPC intent stays unlabelled. Runtime reports replace the pending tag with the session's actual level. Resume retains the existing session level.

**Forgiving `model:` resolution.** A `model:` pin is matched against pi's model registry tolerantly, so cosmetic id variations don't silently drop the agent back to the parent's model: `.` and `-` are treated as equivalent in version numbers (`claude-haiku-4.5` ≡ `claude-haiku-4-5`), a trailing `-YYYYMMDD` date stamp is optional (`anthropic/claude-haiku-4-5-20251001` matches an undated registry id and vice-versa), and a `provider/modelId` whose named provider doesn't carry that model retries the bare id against every provider. Precedence is **exact → fuzzy under the named provider → same model under any provider → unavailable**, so an exact match always wins and dated snapshots aren't conflated. A comma-separated chain tries candidates in order against available models; a selected candidate's thinking suffix supplies the level when the agent omits `thinking:`, while explicit agent `thinking:` remains authoritative. If no configured candidate resolves, execution fails rather than silently inheriting. Only an absent model setting inherits the parent. `/agents → Agent types` flags exhausted chains as `(unavailable)` and shows the resolved target when it differs from configuration. (This is distinct from [Model Scope](#model-scope) enforcement, which matches the `enabledModels` allowlist by *exact* entry.)

### Tool & extension scoping

`extensions:` decides **which extensions load**; `tools:` decides **which tools the agent may see and call**. Both are signed rule lists, omitted or empty means nothing, and the last matching rule wins. The [frontmatter guide](../../docs/guides/agent-frontmatter.md#access-rules) owns the selector grammar and diagnostics.

```yaml
extensions: |
  +builtin:codemode,
  +better-bash-tool, +rtk, +direnv, +filter-outputs,
  +codegraph, +lsp
tools: |
  +@all,
  -@builtin, +read, +bash

isolated: true                    # no extensions load; only granted built-in tools remain
```

A few rules the examples don't make obvious:

- Loading grants nothing; built-in tools are grantable with no extensions loaded. `@all` and `@builtin` in `extensions:` include Pi's built-in extension factories for codemode, tool-search, and mcp, which the runner supplies because SDK sessions do not load them automatically. `builtin:llama.cpp` cannot load in subagents.
- With no `+` extension rule, or under `isolated`, the granted set is a static allowlist. Otherwise every check re-resolves the rules against the live registry, so lazily registered tools (for example MCP-backed ones) are judged when they register. `tools:` only permits: Pi and the owning extension decide which tools are active.
- `subagent_tool_ceiling` hides ungranted declarations from the first turn; the `beforeToolCall` veto and the hidden nested-call guard block ungranted calls, top-level and nested inside codemode.
- The codemode and `tool_search` catalogs may still list ungranted tools; only the veto stops those calls.
- `extensions:` errors fail the spawn. Extension warnings surface as `extension-warning:…` and tool-rule diagnostics as `tools-error:…`/`tools-warning:…` run diagnostics.
- The trusted hook-only `session-local` runtime is internal plumbing and always remains bound.
- An installed **package** extension matches by its package short name (`@scope/pi-subagents` → `pi-subagents`) and its directory name. Prefer the package name.
- `-<id>` is **not a sandbox**: excluded extensions' factory code still executes once during loading. Exclusion suppresses their tools and bound lifecycle hooks, but not other load-time side effects — a factory that subscribes directly to the shared `pi.events` bus stays live.

## Tools

[src/index.ts](src/index.ts) registers the tools; [src/agent-tool.ts](src/agent-tool.ts), [src/result-tools.ts](src/result-tools.ts) and [src/graph/graph-runtime.ts](src/graph/graph-runtime.ts) define their parameters.

- `agent` launches a sub-agent in the foreground or background, or resumes one.
- `get_agent_result` retrieves an independent Agent ID or an `agr_*` graph run ID; `wait: true` waits without polling for terminal output or an actionable human gate, and cancelling it stops only the wait, never the run. Continue non-overlapping work, then collect with `wait: true` rather than ending the turn. Graph run calls show a `[graph]` tag in the call header.
- `resolve_agent_graph_gate` submits the human choice for a returned graph gate.
- `steer_subagent` sends a message to a running agent; it takes effect after the current tool execution.
- `agent_graph` launches a typed graph.

### Graph gates

A graph `gate` contains `gate_id`, `revision`, `kind`, `prompt` and `response_schema`.
Repeated reads return the same pending gate without advancing execution. Collect the
human choice through `ask`, then submit `{ run_id, gate_id, revision, response: { approved: boolean } }`
with `resolve_agent_graph_gate` and wait again. Copy the returned identities exactly.
Responses must satisfy the authored gate schema and current committed execution identity.
Identical accepted responses are idempotent within the activation; stale or conflicting
responses fail. Reload reconstructs pending gates with new revisions and rejects pre-reload
responses, including nested gates: retrieve and ask again. No prompt/response history is
persisted. Acceptance resumes normal checkpointed node settlement; it is not an
exactly-once guarantee across process failure.

Unobserved gates use the existing held follow-up notification channel. Retrieval cancels
its gate nudge, not the gate; retrieving a terminal run consumes its completion notification.
Graph hosts never open a UI prompt themselves.

### `agent_graph`

Typed graph orchestration — the multi-agent launch tool. It takes `graph` (a saved graph name or an inline `AgentGraph`) and `input`, validates before execution, and returns a background run ID. Invalid graphs are rejected in the initiating tool call; graph, agent, gate and condition failures are reported asynchronously. Collect with `get_agent_result({run_id, wait:true})`; handle returned human gates with `ask` and `resolve_agent_graph_gate`, then collect again. Completion notifications (for uncollected runs) and `/agents → Graph runs` supervision remain available.

The bundled [agent-graph skill](skills/agent-graphs/SKILL.md) covers running graphs: saved-graph selection, ad-hoc inline graphs, input, gates and results. Its [authoring reference](skills/agent-graphs/references/authoring.md) covers the typed API: saved and inline graphs, node types (`agent`, `human_gate`, `agent_gate`, `hybrid_gate`, `graph`, `expand`, `fanout`, `bounded_feedback`), edges, conditions, loops, subgraphs, and expansion. Installation of the whole extension includes the skill.

Typed node `outputSchema` drives declarative edge conditions and bounded loops. An `agent` node may carry a `validation.gate` shell command and `retry` configuration; deterministic validation is not a decision gate.

All three decision gates expose exactly `{ approved: boolean }`, with conditions reading `$.approved`. Their required `outputSchema` validates this exposed value. Agent-backed gates require an `agent` selector and use the private structured result `{ status: "decided", decision: { approved: boolean } }` or `{ status: "undecided", reason: "nonempty explanation" }`. Only the latter permits hybrid escalation; invalid output, inability, unavailable agents and execution failures fail closed. Delegation preflight and dispatch authorization cover gate agents. The execution ledger records the decision source, and monitor labels distinguish humans from Subagents. Human requests publish only after the dispatch checkpoint and containing nested checkpoints commit. Hybrid lifecycle resume preserves the human-only boundary without another agent decision; normal host-drain and capacity ownership remain intact.

Graphs separate authored keys, optional display names and durable UUID-v4 runtime instances. Bounded-feedback decisions, bounds, terminal results and public fixture are documented in [Bounded Feedback](skills/agent-graphs/references/bounded-feedback.md); checkpoint and restore internals are in the [bounded-feedback spec](../../docs/specs/agent-graph-bounded-feedback.md). Monitor rows follow materialization order; future iterations are absent. Optional `deadline` bounds elapsed milliseconds from the persisted run start; `spendLimit` bounds reported work/evaluator USD cost, including repairs. Limits stop growth before materialization/continuation with preserved partial evidence; missing execution-cost accounting fails closed rather than estimating tokens. Restore preserves start/costs, while fresh replay starts anew. Already-admitted work may finish beyond a limit.

Graph checkpoints in `.pi/graph-runs/` use atomic replacement, exclusive run leases and append-only versioned manifests before dispatch. Each new snapshot retains its originating exact Pi session ID across writes: only that session auto-resumes it after restart. Other sessions silently ignore it whether its writer is live or dead; ownerless legacy snapshots remain untouched and are never automatically adopted. The lease still prevents concurrent same-session writers. Restore validates filename containment, scheduler state, executable children and recursive delegation policy before creating tasks or writing. Session-owned v1 snapshots upgrade before execution; unknown/corrupt snapshots fail visibly. Retry/restore retain IDs and attempt budgets, while fresh runs allocate new identities. Explicit cancellation is terminal; lifecycle interruptions remain resumable. Crash recovery can repeat external actions; it is not an exactly-once guarantee.

Saved graphs live at `agent-graphs/<name>.graph.json` or `.graph.yaml`; matching formats in one root are ambiguous. [src/graph/saved-graph.ts](src/graph/saved-graph.ts) defines the resolution roots and their priority. The committed [agent-graph portfolio](../../agent-graphs/) contains `context-gather` and `deep-research`; the bundled [agent-graph skill](skills/agent-graphs/SKILL.md) covers invocation and its [authoring reference](skills/agent-graphs/references/authoring.md) covers creation. See the [YAML and invocation-gates spec](../../docs/specs/agent-graph-yaml-invocation-gates.md) for those contracts.

Graph node thinking follows the agent's frontmatter → model-chain suffix → SDK default, never a node override or implicit parent thinking. Ordered model chains, `:fast`, Agent-tree `local://` inheritance, bounded 30-minute Agent retention, and usage/cost controls retain their local contracts.

Graph runs MUST respect active delegation permissions, with independent pool accounting and explicit ownership of their children. Owned children do not receive the `agent_graph` tool recursively. `/agents → Graph runs` keeps one phase-grouped run roster with contextual controls: pause/resume, skip, retry, stop, and child conversation access. FleetView represents each graph run as one row rather than duplicating its owned children.

Settled runs remain visible after same-session reload in `/agents → Graph runs` and Herdr as **read-only metadata history**, not execution recovery. The exact Pi session ID owns `graph-history.json` under the repository's session-local OS storage; forks/new sessions are isolated. History is bounded to 20 runs/8 MiB and retains no full prompts, inputs, outputs, errors, or artifact paths. Live runs win over same-ID history; graph resume checkpoints remain separate. The [Herdr graph presentation spec](../../docs/specs/herdr-agent-graph-presentation.md) owns the graph inspector and history display; the [TUI rendering guide](../../docs/guides/tool-output-tui-rendering.md) covers tool rows and notifications.

Every run also writes `<runId>.trace.jsonl` (graph, input, per-node status/attempt/output/error, end) to the session task artifact area beside node transcripts, kept after settlement and capped at 8 MiB. With `graphRuntimeTrace` on, `<runId>.runtime.jsonl` beside it records XState event/microstep names without context or event payloads. Traces contain inputs and outputs, with the same privacy as node transcripts; graph history never records their paths. Write failures warn once per session and never fail the run.

The agent-graph skill (`skills/agent-graphs/SKILL.md`) is discovered via `resources_discover`. Validate real behavior in a fresh interactive Pi session; see [verification requirements](AGENTS.md#verification).

## Commands

[src/index.ts](src/index.ts) registers the commands:

- `/agents` opens the management menu: running agents (open the conversation viewer, steer with `Enter`, stop with `x` twice), agent types (eject, edit, disable/enable, reset, delete), create a new agent (manual wizard or AI-generated), and settings. Agent type rows show source (`•` project, `◦` global, `✕` disabled) and model, flagging `(unavailable)` chains and `(→ provider/id)` resolutions.
- `/agent-monitor` opens the Agent Monitor.
- `/agent-graph-replay <runId> <graph>` replays a current-session run trace through a saved or file graph's planner without model calls and shows a display-only diff.

## Graceful Max Turns

Instead of hard-aborting at the turn limit, agents get a graceful shutdown:

1. At the `max_turns` soft limit, a final answer completes normally. Only an unfinished tool-use turn receives the wrap-up steering message.
2. Up to 5 grace turns to finish cleanly
3. Hard abort only after the grace period

| Status | Meaning | Icon |
|--------|---------|------|
| `completed` | Finished naturally | `✓` green |
| `steered` | Hit limit, wrapped up in time | `✓` yellow |
| `aborted` | Grace period exceeded | `✗` red |
| `stopped` | User-initiated abort | `■` dim |

## Concurrency

Background agents are subject to a configurable concurrency limit (default: 4). Excess agents are automatically queued and start as running agents complete. The widget shows queued agents as a collapsed count.

Foreground calls have an independent FIFO pool controlled by `maxConcurrentForeground` (`0` = unlimited, the default). Set it in `/agents → Settings` to bound new blocking `agent` calls without competing with background capacity. Queued calls still wait for their complete inline result; Esc cancels a queued or running foreground call. Detached/RPC spawns and resume do not use the foreground pool. Stopping queued work or shutting down releases its waiting caller.

## Join Strategies

When background agents complete, they notify the main agent. The **join mode** controls how these notifications are delivered. It applies only to background agents. Notifications for results already collected with get_agent_result are omitted, and notifications that arrive while the orchestrator's turn runs are delivered at the end of that turn.

| Mode | Behavior |
|------|----------|
| `smart` (default) | 2+ background agents spawned in the same turn are auto-grouped into a single consolidated notification. Solo agents notify individually. |
| `async` | Each agent sends its own notification on completion. Best when results need incremental processing. |
| `group` | Force grouping even when spawning a single agent. Useful when you know more agents will follow. |

**Timeout behavior:** When agents are grouped, a 30-second timeout starts after the first agent completes. If not all agents finish in time, a partial notification is sent with completed results and remaining agents continue with a shorter 15-second re-batch window for stragglers.

**Configuration:**
- Configure join mode in `/agents` → Settings → Join mode

## Model Scope

**Opt-in:** off by default. Enable via `/agents → Settings → Scope models`.

When on, each subagent spawn's effective model is validated against pi's own `enabledModels` list (configured via pi's `/scoped-models` UI). This extension reads that list; it doesn't manage it. Both of pi's settings files are honored: global `~/.pi/agent/settings.json` and project-local `<cwd>/.pi/settings.json`. **Project overrides global** — mirrors pi's `SettingsManager` deep-merge, so a tighter per-project scope (hand-edited into the project settings) is respected.

**Out-of-scope handling depends on source:**

| Model source | Out-of-scope behavior |
|---|---|
| Pinned in agent frontmatter | Warning toast + the pinned model runs (frontmatter is authoritative) |
| Parent-inherited (no frontmatter model) | Warning toast + parent's model runs |

**Design:** `scopeModels` surfaces effective models outside `enabledModels`; it is not a hard policy against user-level config. `agent` tool calls and graph nodes carry no model, so frontmatter pins and parent inheritance always run, with a visible warning when out of scope.

**Pattern format:** only exact `provider/modelId` entries are honored (e.g. `anthropic/claude-haiku-4-5-20251001`). Glob patterns (`*sonnet*`), bare model IDs, and `:thinking` suffixes — which pi itself supports — are silently dropped here. pi's `/scoped-models` picker writes exact entries, so the limitation is invisible if you configure scope through the UI. Hand-edited globs produce an empty allowed set (scope check becomes a no-op).

**No-op safety:** if `enabledModels` is missing or empty in pi's settings, scope check skips entirely — no false positives, no spurious errors.

## Persistent Settings

Runtime settings changed via `/agents` → Settings persist across pi restarts. Two files, merged on load:

- **Global:** `~/.pi/agent/subagents.json` — your machine-wide defaults. Edit by hand; the `/agents` menu never writes here.
- **Project:** `<cwd>/.pi/subagents.json` — per-project overrides. Written by `/agents` → Settings.

**Precedence:** project overrides global on any field present in both. Missing fields fall back to the defaults in [src/settings.ts](src/settings.ts).

[src/settings.ts](src/settings.ts) defines every key and default. Control settings apply live.

Usage reporting includes cache reads because they are billed on every request. The existing display-token total still excludes cache reads. A final tool result drains only unreported deltas; repeated retrieval does not charge the same run again, and resume contributes only new usage. Background spend waits for the next qualifying tool result. Usage collected while reporting is disabled is not backfilled; disabling reporting or changing sessions clears pending deltas. Reporting does not trigger extra model turns. Only total estimated cost is reported; category-level cost breakdowns are not tracked.

The custom QoL footer retains its live accounting: parent assistant-message cost plus the manager's subagent cost. It does not add native tool-result usage a second time. Native session totals may lag the live footer until a tool result reports pending spend. `showCost` affects presentation only; zero/unpriced costs are omitted rather than described as free.

**Disable defaults** (`disableDefaultAgents`, default `false`): when on, the three built-in agents (general-purpose, Explore, Plan) are not registered — only your project/global custom agents are advertised and spawnable. User-defined agents are unaffected, including ones that override a default by name. The `agent` tool's type list updates on the next pi session (the tool schema is registered at startup).

**Output transcript** (`outputTranscript`, default `true`): the project/global default for writing each subagent's `.output` transcript. Toggle via `/agents → Settings → Output transcript`, or set `false` in `subagents.json` to make transcripts opt-in project-wide — useful when run transcripts shouldn't sit on disk for backup or DLP tooling to pick up. A custom agent's `output_transcript` frontmatter overrides this per agent. Applied live at spawn time. Governs only the transcript, not `persist_session` or memory files.

**Tool description** (`toolDescriptionMode`, default `"full"`): which `agent` tool description the LLM sees. `"full"` is the rich Claude Code-style prompt (~1,400 tokens with the default agents); `"compact"` is ~75% smaller — one-line configured-agent list, terse usage notes — for small/local models where tool-spec tokens are expensive. The `subagent_type` parameter points to this roster without repeating agent names. Applies on the next pi session.

The configured roster is capability metadata, not delegation authority. While the `agent` tool is active, the extension adds one replaceable system-prompt hint containing the current mode's permitted target names. It derives from the same persisted delegation policy as runtime enforcement, stays byte-stable while the mode is unchanged, and replaces the prior hint after a mode or branch change instead of accumulating stale messages.

`"custom"` registers your own description from `<cwd>/.pi/agent-tool-description.md` (project) or `<agentDir>/agent-tool-description.md` (global; project wins). The file is read once at tool registration, so edits also apply on the next pi session. Dynamic parts stay live via placeholders — a static configured-agent list would go stale the moment you add a custom agent:

```markdown
Launch an autonomous agent. Configured types:
{{typeList}}

Custom agents live in .pi/agents/ or {{agentDir}}/agents/.
```

Placeholders: `{{typeList}}` (full per-agent descriptions), `{{compactTypeList}}` (first sentence each), `{{agentDir}}`. Unknown placeholders are left verbatim with a stderr warning; a missing or empty file falls back to `"full"` with a warning. Note the usual trust umbrella: a project-level file shapes the orchestrator's prompt, same as project agents and extensions do.

**Starting point:** copy [`examples/agent-tool-description.md`](examples/agent-tool-description.md) — it reproduces the default full description exactly (a CI test keeps it in sync), so you can trim from a known-good baseline instead of writing from scratch.

**Example — global defaults for a beefy machine:**

```bash
mkdir -p ~/.pi/agent
cat > ~/.pi/agent/subagents.json <<'EOF'
{
  "maxConcurrent": 16,
  "graceTurns": 10
}
EOF
```

Every project now starts with concurrency 16 and grace 10, without ever touching the menu. Individual projects can still override via `/agents` → Settings.

**Failure behavior:** missing file is silent; malformed JSON logs a warning to stderr; invalid/out-of-range field values are dropped per-field; write failures downgrade the `/agents` toast to a warning with `(session only; failed to persist)`.

## Events

The extension emits the `subagents:*` lifecycle event family (agent created/started/completed/failed/steered/compacted, scheduling, readiness and settings) on `pi.events` from [src/index.ts](src/index.ts) and [src/agent-tool.ts](src/agent-tool.ts); see [../CONVENTIONS.md](../CONVENTIONS.md) for event conventions.

## Cross-Extension RPC

Other pi extensions can spawn and stop subagents through the `pi.events` bus without importing this package. [src/cross-extension-rpc.ts](src/cross-extension-rpc.ts) defines the payloads.

- Requests go to `subagents:rpc:<method>` with a `requestId`; methods are `ping` (returns the protocol version), `spawn` (returns the agent ID) and `stop`.
- Replies arrive on `subagents:rpc:<method>:reply:${requestId}`, so concurrent requests don't interfere.
- Every reply uses the envelope `{ success: true, data?: T }` or `{ success: false, error: string }`.
- `subagents:ready` fires when the handlers are registered on session start. A session that excludes this extension emits no `subagents:ready` and does not answer the RPC channels; give discovery a timeout.

`spawn` accepts `options.model` as a `Model` object or a `"provider/modelId"` string resolved against `ctx.modelRegistry`. `options.cwd` (an existing absolute directory) runs the agent elsewhere, but `.pi` config, agents, skills, settings and memory still come from the parent session's project.

## Persistent Agent Memory

Agents can have persistent memory across sessions. Set `memory` in frontmatter to enable:

```yaml
---
memory: project   # project | local | user
---
```

| Scope | Location | Use case |
|-------|----------|----------|
| `project` | `.pi/agent-memory/<name>/` | Shared across the team (committed) |
| `local` | `.pi/agent-memory-local/<name>/` | Machine-specific (gitignored) |
| `user` | `<agentDir>/agent-memory/<name>/` (default `~/.pi/agent/agent-memory/`, honors `PI_CODING_AGENT_DIR`) | Global personal memory |

Memory uses a `MEMORY.md` index file and individual memory files with frontmatter. Agents with write tools get full read-write access. **Read-only agents** (no `write`/`edit` tools) automatically get read-only memory — they can consume memories written by other agents but cannot modify them. This prevents unintended tool escalation.

The `disallowed_tools` field is respected when determining write capability — an agent with `tools: write` + `disallowed_tools: write` correctly gets read-only memory.

## Skill Preloading

Skills can be preloaded by name and injected into the agent's system prompt:

```yaml
---
skills: api-conventions, error-handling
---
```

[src/skill-loader.ts](src/skill-loader.ts) defines the discovery roots (project `.pi/skills/` and `.agents/skills/`, then user locations) and their order; the first match wins.

**Per root, a skill named `foo` resolves to the first of:**

- `<root>/foo.md` — flat file at the top level
- `<root>/foo/SKILL.md` — directory skill (top-level)
- `<root>/*/.../foo/SKILL.md` — directory skill, found by recursive descent

Recursion skips dotfile directories and `node_modules`. A directory that itself contains a `SKILL.md` is treated as a single skill — we don't descend into it. Traversal is byte-order sorted for deterministic resolution across filesystems.

**Security:** symlinks are rejected at every layer (root, flat file, skill directory, `SKILL.md` inside a skill directory) — intentional deviation from Pi, which follows symlinks. Skill names with path-traversal characters (`..`, `/`, `\`, spaces, leading dot, >128 chars) are rejected.

## Tool Denylist

Block specific tools from an agent even if extensions provide them:

```yaml
---
tools: read, bash, grep, write
disallowed_tools: write, edit
---
```

This is useful for creating agents that inherit extension tools but should not have write access.
