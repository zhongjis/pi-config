---
name: agent-graphs
description: Author, validate, run, and debug typed agent graphs for the `agent_graph` tool. Use when building or editing a saved `.graph.json` or `.graph.yaml` graph, an inline graph, or when a task is a multi-step / branching / looping / parallel agent graph.
---

You author **agent graphs**: typed, declarative graphs of agent work that the
`agent_graph` tool executes. A graph is data, not code — the runtime validates it
before anything runs, executes it via XState with a dependency scheduler, and
shows it live in `/agents → Graph runs`.

Prefer a graph over ad-hoc `Agent` calls when the work has real structure:
dependencies, branching on a result, bounded retry/loops, parallel fan-out, a
human approval gate, or a reusable subgraph.

## Running a graph

```ts
agent_graph({
  graph: "context-gather",
  input: {
    request: "...",
    requiredCoverage: [
      { id: "repository", criterion: "Current repository behavior" },
      { id: "upstream", criterion: "Authoritative upstream contract" },
    ],
  },
})
agent_graph({ graph: { nodes: {...}, edges: [...], outputs: {...} }, input: {...} })
```

- **Saved graphs** live at `agent-graphs/<name>.graph.json` or `.graph.yaml`; a `/` in the name maps to a
  subdirectory (e.g. `team/my-graph` → `agent-graphs/team/my-graph.graph.yaml`). Matching JSON and YAML names in one root are ambiguous. Author with normal file tools; no CRUD tool.
- The call returns a **task id immediately** and runs in the background; you are
  notified on completion. Do not poll. Watch it in `/agents → Graph runs` (nodes
  grouped by stage, with pause / skip / retry).
- Invalid graphs are rejected **before** any node runs, with per-error messages.

## Consuming a run result

The call returns a task id immediately and runs in the background; you are notified on
completion with a `<task-notification>`. Read it in this order:

1. `<status>` — the declared outcome. `Completed` means the graph did not flag a
   problem; `Outcome partial: <reason>` or `Outcome failed: <reason>`
   means it did. Trust this over the raw agent counts.
2. `<summary>` — `Execution: <state> — N/M agents completed, X failed, Y skipped`
   (`X failed` already excludes intentional skips).
3. `<result>` — a bounded (~500-char) preview, a top-level `summary` field when present.
4. `<result-file>` — present only when the full result overflowed the preview; read it
   for the complete structured output.

Triage rule: on a `partial`/`failed` status, or any `X failed` > 0, open `<result-file>`
and inspect the failed children plus the output's `unknowns`. Whether a failure matters
is graph-specific — `context-gather` folds failed or skipped evidence into `unknowns` and
keeps the partial evidence, so a failure there is usually expected degraded coverage,
whereas a graph whose children are deterministic gates would signal a real problem.
Depend only on the validated structured outputs, never on an agent's prose.

## Graph shape (`AgentGraph`)

```jsonc
{
  "description": "Optional live-run purpose shown in the Agent Monitor",
  "inputSchema": { /* optional JSON Schema for `input` */ },
  "nodes": { "<id>": { /* GraphNode */ } },
  "edges": [ { "from": "<id>", "to": "<id>", "when": <Condition>, "loop": { "maxIterations": 3 } } ],
  "outputs": { "<name>": { "node": "<id>", "path": "$.field" } }
}
```

Nodes are keyed by unique id. Edges are dependencies: a node runs once all its
**forward** (non-`loop`) predecessors have settled and at least one incoming edge
is active (its source completed and its `when` holds). If every incoming edge
settled but none activated, the node is **skipped**.

## Node types

- **agent** — runs a Pi subagent.
  ```jsonc
  { "type": "agent", "agent": "jintong", "prompt": "Fix ${task}",
    "input": { "task": { "path": "$.task" } },
    "outputSchema": { "type": "object", "properties": { "approved": { "type": "boolean" } }, "required": ["approved"] },
    "validation": { "gate": "npm test" }, "retry": { "maxAttempts": 2 }, "resources": ["workspace:main"] }
  ```
  `prompt` is a template: `${name}` is replaced by the resolved value of `input.name`.
  With `outputSchema` the child must return matching structured JSON. `validation.gate`
  is a shell command that must pass; `retry.maxAttempts` re-runs on schema/gate failure.
- **human_gate** — human-only approve/reject through the existing UI; never spawns an agent.
- **agent_gate** — a configured `agent` decides; no human fallback.
- **hybrid_gate** — the configured `agent` decides first; only a valid typed `undecided`
  with a nonempty reason opens the human approve/reject UI.
  ```jsonc
  { "type": "hybrid_gate", "agent": "yanluo", "prompt": "Approve the plan?",
    "outputSchema": { "type": "object", "properties": { "approved": { "type": "boolean" } },
      "required": ["approved"], "additionalProperties": false } }
  ```
  All three decision gates require `prompt` and `outputSchema`, support template `input`,
  and expose exactly `{ "approved": boolean }`; conditions read `$.approved`.
  `outputSchema` constrains this exposed value, not the private agent result.
  Agent-backed gates use a strict internal structured protocol:
  `{ "status": "decided", "decision": { "approved": boolean } }` or
  `{ "status": "undecided", "reason": "nonempty explanation" }` (no extra fields).
  `agent_gate` fails on `undecided`. Invalid output, inability, unavailable agents and
  execution failures fail both agent-backed gates without prompting. Gate agents obey
  normal delegation permissions. Hybrid escalation is checkpointed before prompting;
  lifecycle resume of a waiting hybrid preserves the human choice rather than rerunning
  its agent. The monitor identifies the decision maker as human or the configured agent.
- **graph** — runs a saved subgraph and uses its `outputs` as this node's output.
  ```jsonc
  { "type": "graph", "graph": "context-gather", "input": { "task": { "path": "$.task" } } }
  ```
- **fanout** — materializes a typed runtime item array as ordinary agent children,
  awaits every child, and returns input-ordered all-settled results.
  ```jsonc
  { "type": "fanout", "items": { "path": "$.tasks" },
    "itemSchema": { "type": "object", "properties": { "kind": { "type": "string" } }, "required": ["kind"] },
    "dispatch": { "path": "$.kind", "cases": { "project": "chengfeng" } },
    "prompt": "Task: ${item}", "phase": { "index": 0, "title": "Round 1/2" } }
  ```
- **expand** — splices a `GraphFragment` produced at runtime into the live graph
  (dynamic topology). `source` must resolve to `{ nodes, edges, outputs? }`; use
  `namespace` to isolate the inserted ids.
  ```jsonc
  { "type": "expand", "source": { "node": "plan", "path": "$.fragment" }, "namespace": "t" }
  ```

There is **no** shell/action node — deterministic checks are a node's `validation.gate`.

## ValueRef — wiring values

A `ValueRef` reads a value: `{ "node": "<id>", "path": "$.field" }` reads a node's
validated output; omit `node` to read the graph `input`. `path` is a small JSONPath
(`$`, `$.a`, `$.a.b`, `$.arr[0]`). Used for node `input`, `outputs`, and condition operands.

## Conditions (edge guards)

Small and serializable — no code:

```jsonc
{ "eq": [ { "node": "review", "path": "$.approved" }, true ] }
```

Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `exists`, and `and` / `or` / `not`.
A missing value is unsatisfied (except `ne`, which holds).

## Loops

An edge with `loop: { maxIterations: N }` may re-enter an already-run node — this
is how you build a review→fix→review cycle. Every edge that closes a cycle must
declare `loop`; the cap bounds it.

```jsonc
"edges": [
  { "from": "implement", "to": "review" },
  { "from": "review", "to": "done", "when": { "eq": [ { "node": "review", "path": "$.approved" }, true ] } },
  { "from": "review", "to": "fix",  "when": { "eq": [ { "node": "review", "path": "$.approved" }, false ] } },
  { "from": "fix", "to": "review", "loop": { "maxIterations": 3 } }
]
```

## Dynamic expansion

Use `fanout` for a runtime list of same-contract tasks; use `expand` when a node
produces a complete `GraphFragment`. A fanout validates and inserts all children
atomically, remains running until they all settle, and exposes ordered successes and
failures. In version 1, model bounded evaluation with explicit fanout nodes per round,
not a loop back into one fanout. Version 2 offers `bounded_feedback` with fixed work
and evaluator templates; read [Bounded Feedback](references/bounded-feedback.md)
for its required bounds, typed decisions, accumulation and durable identity contract.

Read [Dynamic Expansion](references/dynamic-expansion.md) for typed task schemas,
dispatch, awaited collection, round namespaces, bounded evaluators, and failure handling.

## Evaluation architecture

Use bounded feedback as a typed judge only when another iteration has a specific decision to make.

- **State** — evaluator reads validated evidence, failures, conflicts, and named gaps.
- **Transition** — continue only for one named material gap with distinct access, expected information, and narrower non-repeated work.
- **Progress** — runtime rejects repeated task collections, no new validated output, and bound overrun.
- **Outcome** — synthesis declares succeeded, partial, or failed from retained evidence and gaps.

```jsonc
"work": {
  "itemSchema": { "type": "object", "required": ["source", "question"], "properties": { "source": { "type": "string" }, "question": { "type": "string" } } },
  "prompt": "Gather one atomic gap-closing fact: ${item}"
},
"evaluator": {
  "type": "agent",
  "prompt": "State/transition judge. ${feedback} Continue only for one named material gap with distinct access and expected new information; otherwise sufficient with named gaps.",
  "input": { "goal": { "path": "$.goal" } }
}
```

The evaluator's injected decision links each `gapId` to a work item satisfying `itemSchema`; read [Bounded Feedback](references/bounded-feedback.md) for decision shape, bounds, persistence, and termination.

### When not to add a judge

- One pass answers the request → use ordinary fanout.
- Deterministic validation decides → use schema, gate, or condition.
- No typed evidence state exists → collect it first.
- No downstream decision or repair uses the verdict → evaluate offline.

### Trace-driven refinement

1. Capture graph, inputs, structured outputs, activated branches, failures, retries, bounds, cost, and latency.
2. Name one transition failure and propose one graph change; keep authority, schemas, and hard bounds immutable.
3. Run baseline and candidate against the same replayable cases; grade state, transition, progress, outcome, cost, and latency.
4. Promote the candidate only after held-out improvement and human review; retain the prior graph for rollback.

## Resources

A node's `resources: ["workspace:main"]` are admitted only while under the
capacity passed to the run. Two nodes sharing a capacity-1 resource serialize
even when their dependencies would allow parallelism.

## Declaring the run outcome

A graph declares its objective outcome — independent of execution success — by emitting a
reserved output named `$agentGraphOutcome`:

```jsonc
"outputs": {
  "$agentGraphOutcome": { "node": "synthesize", "path": "$.outcome" }
}
```

where the `synthesize` node returns `{ "status": "succeeded" }` or
`{ "status": "partial" | "failed", "reason": "<why>" }`. The runtime consumes this
envelope, strips it from the returned value, and surfaces it as the completion status
(`Outcome succeeded` / `Outcome partial: <reason>` / `Outcome failed: <reason>`, shown as
`Outcome … · <name>` on the collapsed card). Omit it and the run defaults to
`Completed`; a malformed envelope is ignored and never fails an already-completed run.

## Authoring steps

1. Write the graph (inline, `.graph.json`, or `.graph.yaml`), keeping ids and dependencies explicit.
2. Run it — the tool validates first, so a shape error comes back before any cost.
3. Watch `/agents → Graph runs`: nodes are grouped by stage with live status;
   conditional edges show which branch fired; expanded nodes appear as they insert.
4. Depend only on validated structured output (`outputSchema` + `ValueRef`), never
   on an agent's prose.
5. Promote a proven inline graph to `agent-graphs/<name>.graph.json` or `.graph.yaml`.
