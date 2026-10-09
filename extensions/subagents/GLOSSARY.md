# Subagents Extension

Vocabulary for the subagents extension: Subagent executions, and the typed multi-agent orchestration subsystem — agent graphs, their runs, and the node types that compose them. Refines the harness-wide terms in the [root context](../../GLOSSARY.md).

## Executions

**Subagent instance**:
A Subagent launched with a public agent id: one child session that every Execution on it shares, that survives eviction, and that resume addresses by id.
_Avoid_: agent (for the instance), agent record, run

**Execution**:
One prompt run on a Subagent instance — the initial spawn or any later resume — with its own execution id and terminal status.
_Avoid_: run, turn, invocation

**Settlement**:
The point an Execution physically drains: its session is idle and its owner releases capacity. Distinct from the Execution's visible status; a stopped Execution may not yet be settled.
_Avoid_: completion, stop (for drain)

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

**Decision gate**:
A `decision_gate` node that answers typed questions about supplied state, each answer with a confidence, and records who decided.
_Avoid_: human gate, approval gate, agent gate, hybrid gate

**Judge**:
The optional decision gate inside a bounded feedback node that decides whether an iteration's evidence is sufficient; the evaluator then only writes gaps and tasks.
_Avoid_: evaluator (for the sufficiency decision), reviewer

## Decisions

**Classifier model**:
A non-chat model that answers typed questions with probabilities; the preferred decider for a decision gate.
_Avoid_: classifier agent, judge model

**Agent fallback**:
The runtime-internal, unregistered agent that emulates a classifier model on a chat model when no classifier decides.
_Avoid_: Panguan, gate agent

**Escalation**:
Handing a decision gate that is undecided or below its confidence threshold to the orchestrator that invoked the agent graph, which decides or asks the human.
_Avoid_: human approval, human gate, fallback
