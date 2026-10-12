# 7. Nested research runs through a root-manager bridge

Status: shipped
Date: 2026-10-12
Related: [../../extensions/subagents/AGENTS.md](../../extensions/subagents/AGENTS.md) · [../../extensions/subagents/src/research-delegation.ts](../../extensions/subagents/src/research-delegation.ts) · [../guides/agent-frontmatter.md](../guides/agent-frontmatter.md#delegation-fields)

## Context

The manifesto states that Subagents do not delegate, and that nesting stays off unless an agent opts in with `allow_nesting`. The runtime only had the first half. Every Subagent session excluded `agent`, `get_agent_result`, `resolve_agent_graph_gate`, `steer_subagent`, and `agent_graph`. In a Subagent, `allow_nesting` and the delegation fields had no effect.

A consultant such as Taishang sometimes needs codebase facts or external sources partway through its reasoning. Without delegation it must do that reconnaissance itself or return the question to its caller.

Loading the subagents extension inside a child session would expose those tools, but:

- **Policy fails open.** A child session has no `agent-mode` entry, so the delegation-policy resolver returns `unrestricted`.
- **Trust boundary.** The child would get the full orchestration surface: background runs, resume, steering, graphs, and gate resolution.
- **Split state.** A second `AgentManager` would split capacity, history, UI, and usage away from the root session.

## Decision

1. **One trusted inline tool.** The runner registers `delegate_research({subagent_type, prompt, description})` as a trusted inline extension factory. The orchestration tools stay excluded from every Subagent session.
2. **Opt-in at depth 1.** The tool loads only when the run's agent config has `allow_nesting: true` and a non-empty `allow_delegation_to`, the run is not graph-owned or isolated, and the run is not itself nested (`AgentRecord.parentAgentId` is unset).
3. **Read-only leaf targets, re-resolved on every call.** [`resolveNestedTargets`](../../extensions/subagents/src/delegation-policy.ts) takes the allowlist minus `disallow_delegation_to`, and an empty allowlist permits nothing. A target must be enabled. It must not have `allow_nesting`, be the caller's own type, or use `prompt_mode: append`. It must be granted no `edit`, `write`, or `powershell`, and `bash` only under the guarded read-only Bash.
4. **The root manager executes.** A private `AgentManager` helper builds the bridge for each root-level run. Each call spawns on the root manager with the root ctx, so the mode delegation policy still applies and its denial text is returned. The run is detached: it takes no foreground or background slot, it is consumed inline with no completion notification, and it shares root history, usage, and the widget, where it is tagged `nested`.
5. **The caller blocks.** The call returns the child's final text, agent ID, status, and error to the calling Subagent only, and never throws. The run uses the caller's working directory and gets no inherited context. The tool's AbortSignal stops it. Calls have no background, resume, steering, graph, gate, isolation, or model options. Each parent may have at most 3 concurrent nested runs; extra calls fail instead of queuing.

## Consequences

- Taishang can use Chengfeng and Wenchang for focused research. It remains responsible for checking their evidence.
- `tools:` rules cannot grant or remove the trusted tool. Only `allow_nesting` and the allowlist control it.
- A blocked parent holds its own slot while its nested runs take none. Pi runs the tool calls of one assistant turn concurrently, so the per-parent cap is the only fan-out limit.
- The read-only check covers built-in tools only. An extension tool that mutates state is outside the mechanical check and stays the agent author's responsibility.
- The cap is a fixed constant. A configurable limit needs a subagents setting.

## Alternatives considered

- **Load the subagents extension in children.** Policy fails open without an `agent-mode` entry, the full orchestration surface would cross the trust boundary, and a second manager would split capacity, history, UI, and usage.
- **Expose `agent` behind `allow_nesting`.** Gives children background runs, resume, and steering, and any target type.
- **Use the foreground pool for nested runs.** A nested run could queue behind its own blocked parent and deadlock.
- **Allow deeper nesting or nesting targets.** Unbounded fan-out and cost, with no use case yet.
