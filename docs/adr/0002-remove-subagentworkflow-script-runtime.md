# 2. Remove the SubagentWorkflow script runtime

Status: shipped
Date: 2026-09-17
Supersedes: [agent-graph-design-v2.md §2.8](../ideas/agent-graph-design-v2.md) deferral of legacy removal
Related: [agent-graph-reusable-workflows.md](../specs/agent-graph-reusable-workflows.md) · [agent-graph-implementation.md](../guides/agent-graph-implementation.md)

## Context

The typed `agent_graph` runtime shipped (agent-graph-design-v2.md §1): a pure-data
`AgentGraph` IR, an XState node runtime, a dependency/resource scheduler, typed node
outputs, conditions, bounded loops, human gates, saved subgraphs, and runtime
`GraphFragment` expansion — with a `/agents → Workflows` monitor.

The old `SubagentWorkflow` tool executed model-authored JavaScript in a worker-thread
sandbox (`src/graph/runtime.ts`, `worker-source.ts`, `host.ts`, `saved.ts`,
`collisions.ts`, `meta.ts`, `journal.ts`). Design §2.8 deferred removing it, but noted
its own condition: the two out-of-scope script workflows (`deep-research.js`,
`last30days.js`) were to be **discarded, not ported**, so "nothing external gates
removing the legacy runtime once Section 1 reaches parity for in-scope use."

Two things then made removal safe:

1. The reusable-workflow portfolio (agent-graph-reusable-workflows.md) —
   `shared/context-gather`, `shared/review-loop`, `shared/work-verify`, `fuxi/ulw-plan`,
   `houtu/execute-plan`, `kuafu/ulw` — was authored, validated, and **run for real**.
   This is the reusable-workflow replacement the deferral was waiting on.
2. Those real runs hardened the runtime: a model passes a graph `input` as a JSON string,
   so `agent_graph` now coerces it back to a value; an unmapped `${placeholder}` is now a
   validation error; each node's resolved model shows in the monitor.

Keeping two runtimes meant a 50 KB script sandbox, a worker-thread source blob, and their
tests living beside the graph runtime with only shared monitor types entangling them.

## Decision

Remove the `SubagentWorkflow` script runtime. `agent_graph` is the single execution tool;
saved graphs live under `.pi/agent-graphs/`.

Removed:

- Script runtime source: `src/graph/{runtime,worker-source,host,saved,collisions,meta,journal}.ts`.
- The `SubagentWorkflow` tool and the `--subagents-workflow-file` startup flag.
- The `subagent-workflows` authoring skill.
- The two discarded scripts (`workflows/deep-research.js`, `workflows/last30days.js`), the
  now-empty `workflows/` tree, and its `install.sh` symlink wiring.
- `SubagentWorkflow` from the kuafu/houtu/fuxi mode frontmatter and `modes/AGENTS.md`.
- The legacy script tests (extension + root).

Relocated: the shared monitor types `WorkflowControl`, `WorkflowRunResult`, `WorkflowMeta`,
`WorkflowPhaseMeta` moved from the deleted modules to `src/graph/workflow-types.ts`.

Kept: the whole graph runtime and the monitor, including `WorkflowTask`, the
`workflowsEnabled` gate (now gating `agent_graph`), and `WORKFLOW_ENTRY_TYPE` /
`workflowEntryData` / `entry.ts` — the graph completion notification uses them.

## Consequences

- One execution runtime. No worker-thread script sandbox, no script journal/replay.
- Fewer files and a simpler ownership story: the monitor renders graph runs only.
- `workflowsEnabled` and the monitor's "workflow" vocabulary persist because they now serve
  the graph runtime; the naming is historical, not a second runtime.
- Graph authoring guidance lives in `extensions/subagents/skills/agent-graphs/SKILL.md`.
- Verification baseline after removal: `pnpm --dir extensions/subagents typecheck` clean;
  `pnpm test:extensions` green except the pre-existing Herdr-pane WIP failures (the legacy
  `workflow-host` shell-smoke test that was the 9th baseline failure is gone with the
  runtime it tested).
