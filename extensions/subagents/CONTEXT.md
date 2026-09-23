# Subagents Extension

Vocabulary for the typed multi-agent orchestration subsystem of the subagents extension: agent graphs, their runs, and the node types that compose them. Refines the harness-wide terms in the [root context](../../CONTEXT.md).

## Agent graphs

**Agent graph**:
A typed, declarative structure of nodes and edges — the `AgentGraph` — describing a multi-agent run. It is data, not code, executed by the `agent_graph` tool.
_Avoid_: graph, workflow, flow, pipeline, DAG

**Saved agent graph**:
An agent graph stored on disk as `<name>.graph.json` and invoked by name. The short form "saved graph" is fine where "agent graph" is already established.
_Avoid_: saved workflow

**Agent graph run**:
One execution instance of an agent graph, with its own lifecycle, checkpoints, and outcome. The short form "graph run" is fine on a surface that already says "agent graph".
_Avoid_: workflow, workflow run, run (standalone noun), graph (as a run noun)

**Workflow** — retired:
The obsolete name for an agent graph run and for the orchestration feature, left from the removed SubagentWorkflow script runtime. Use *agent graph run* for an instance and *agent graph orchestration* for the feature; do not use "workflow" in new names, prose, or UI.

**Outcome**:
The declared domain result of an agent graph run — `succeeded`, `partial`, or `failed` with a reason — separate from the execution lifecycle.
_Avoid_: workflow outcome, result, status

## Node types

**Fanout**:
A node that dispatches one input-ordered batch of agents and awaits all of them (all-settled).
_Avoid_: parallel, map, scatter-gather

**Bounded feedback**:
A node that repeats a fanout/evaluator pair under explicit bounds — iterations, items, cost, deadline — retaining every iteration.
_Avoid_: loop, retry loop

**Subgraph**:
An agent graph run nested inside another as a single node; a reusable capability, not a user-facing run boundary.
_Avoid_: sub-workflow, child graph

**Expand**:
A node that splices a runtime-generated graph fragment into the running agent graph.
_Avoid_: dynamic node, expansion
