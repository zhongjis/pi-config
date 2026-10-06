## Purpose

The repo-committed reusable agent-graph portfolio: saved `AgentGraph`s the `agent_graph` tool runs.

## Ownership

- Owns `context-gather.graph.json` and `deep-research.graph.json` at the directory root, and the `deep-research/plan.graph.json` subgraph.
- The `agent_graph` runtime and its contracts live in [../extensions/subagents](../extensions/subagents/AGENTS.md).

## Local Contracts

- Saved graphs are JSON or YAML `AgentGraph`s resolved by filename (`context-gather`, `deep-research`); a `/` in a graph name maps to a subdirectory. Within one resolution root, matching `.graph.json` and `.graph.yaml` files are ambiguous.
- Every graph MUST pass `validateGraph`; a prompt `${placeholder}` MUST be wired in the node's `input`, except a bounded-feedback evaluator's runtime-reserved `${feedback}`.
- Nodes select work by `agent`; model and thinking come only from that agent's frontmatter chain. Saved graphs MUST NOT set node model, effort, or thinking.
- `install.sh` symlinks this directory to `~/.pi/agent/agent-graphs` for global resolution. Resolution roots, highest priority first: `<cwd>/.pi/agent-graphs`, `<cwd>/agent-graphs`, `<cwd>/.agents/agent-graphs`, then `~/.pi/agent/agent-graphs`.
- Saved-graph outcome schemas MUST match the runtime envelope exactly: `succeeded` omits `reason`; `partial`/`failed` require a nonblank `reason`. Any other envelope is silently ignored and the run shows `Completed`.
- Every mode that runs `deep-research` MUST allow `panguan` and `simaqian` delegation.
- Before changing, running or integrating `context-gather`, you MUST read its [graph-specific contracts](README.md#context-gather).
- Before changing, running or integrating `deep-research` or `deep-research/plan`, you MUST read its [graph-specific contracts](README.md#deep-research).

## Work Guidance

- When authoring or editing a graph, you MUST read the [graph authoring reference](../extensions/subagents/skills/agent-graphs/references/authoring.md); bounded-feedback work also requires its [contract](../extensions/subagents/skills/agent-graphs/references/bounded-feedback.md).
- Depend only on validated structured node output (`outputSchema` + ValueRef), never on an agent's prose.
- Promote a proven inline graph here; keep node ids and dependencies explicit.

## Verification

- `pnpm --dir extensions/subagents exec vitest run test/graph-portfolio.test.ts test/graph-deep-research-policy.test.ts` validates saved graphs and exercises context-gather policy; graph-deep-research-policy covers deep-research policy.

## Child DOX Index

- None.
