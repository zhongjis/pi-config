---
name: agent-graphs
description: Author, validate, run, and debug typed agent graphs for the `agent_graph` tool. Use when building or editing a saved `.graph.json` or `.graph.yaml` graph, an inline graph, or when a task is a multi-step / branching / looping / parallel agent graph.
---

You author **agent graphs**: typed, declarative graphs of agent work that the
`agent_graph` tool executes. A graph is data, not code — the runtime validates it
before anything runs, executes it via XState with a dependency scheduler, and
shows it live in `/agents → Graph runs`.

Prefer a graph over ad-hoc `agent` calls when the work has real structure:
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
- The call returns a **run ID immediately**. Continue only non-overlapping work,
  then MUST call `get_agent_result({run_id, wait:true})`. NEVER end the turn, poll
  or sleep while the run is active. `/agents → Graph runs` provides supervision.
- Invalid graphs are rejected **before** any node runs, with per-error messages.

## Consuming a run result

`get_agent_result({run_id, wait:true})` returns graph execution status, output and
objective outcome, or a pending `gate` with `gate_id`, `revision`, `kind`, `prompt`
and `response_schema`. Details discriminate `kind: "graph"` from independent agents.

For a gate, MUST use `ask` to collect the human's choice, then call:

```ts
resolve_agent_graph_gate({ run_id, gate_id, revision, response: { approved: true } })
get_agent_result({ run_id, wait: true })
```

Copy returned identities exactly and submit the actual human response; NEVER invent
approval. Repeated retrieval does not consume a gate. Identical responses are idempotent
within the activation; stale/conflicting responses fail. Reload reconstructs pending
gates with fresh revisions, including nested gates; retrieve again before asking.
Cancelling retrieval stops only that wait. Unobserved gates receive an actionable
follow-up; observed gates do not receive duplicate nudges.

Completion notifications remain available as `<task-notification>`. Read them in this order:

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
- **human_gate** — publishes a durable human request for orchestrator `ask` + resolution; never spawns an agent.
- **agent_gate** — a configured `agent` decides; no human fallback.
- **hybrid_gate** — the configured `agent` decides first; only a valid typed `undecided`
  with a nonempty reason publishes a human request.
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
  normal delegation permissions. Hybrid escalation is checkpointed before publication;
  lifecycle resume of a waiting hybrid preserves the human-only boundary rather than
  rerunning its agent. The monitor identifies the decision maker as human or the configured agent.
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

The cap stops only its own edge. After the last re-entry, the final `fix` output goes
unreviewed, `done` is skipped, and the run still completes. Keep `loop` on the back edge
into the judge (`fix → review`); a `loop` on `review → fix` validates yet skips `fix`.
Declare `$agentGraphOutcome` from the judge so a capped run reports its last verdict.

## Determinism contract

The graph is the machine: it owns rules, identity, and transitions. Agents own the
generative work inside one state, and every next step follows from validated output.

- **Rules live in the machine.** When typed data can decide a rule, enforce it with
  `enum`/`const`/`if`–`then`, a condition, a `semanticPolicy`, or `validation.gate`.
  A prompt may restate the rule as a hint; the machine enforces it.
- **Branches are typed events.** A branching node emits one enum field, and each value
  gets exactly one guarded edge. Prompts describe their state's work; edges carry order.
  ```jsonc
  // review node
  "outputSchema": { "type": "object", "required": ["event"], "properties": { "event": { "enum": ["approve", "revise", "escalate"] } } }
  // edges
  { "from": "review", "to": "ship",  "when": { "eq": [ { "node": "review", "path": "$.event" }, "approve" ] } },
  { "from": "review", "to": "fix",   "when": { "eq": [ { "node": "review", "path": "$.event" }, "revise" ] } },
  { "from": "review", "to": "human", "when": { "eq": [ { "node": "review", "path": "$.event" }, "escalate" ] } }
  ```
- **Side effects sit behind approval.** Reach nodes that write, send, or push only
  through an `approved: true` gate edge or a passing `validation.gate`.
- **Outcome follows evidence.** Couple outcome fields to evidence with `if`/`then` so only
  the matching status validates (see `context-gather` synthesis). Read values the machine
  already holds, such as a fanout child's `item`, instead of asking agents to echo them.
- **The machine hands out identity.** Parallel children see only `${item}`, so have one
  upstream node give each item a `taskId`, prefix derived IDs with it, and constrain both
  with `pattern`. Item IDs make every task collection look new to the runtime's exact
  repeat check, so progress then rests on the evaluator's transition rule and hard bounds.
- **Validate at the owning state.** Reject bad output in the node that produced it, where
  StructuredOutput rejection lets that agent correct itself. Downstream nodes cannot
  repair upstream data, and a node retry reruns the same prompt.

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
   The run result carries outputs and bounded-feedback `feedback` (iterations, tasks, results, `reason`,
   `exhaustedBounds`); session `graph-history.json` keeps per-node status, attempts, timing, and tokens
   without outputs; `.pi/graph-runs/` checkpoints are deleted when a run settles.
2. Name one transition failure and have an agent other than the judged nodes propose one graph change;
   keep authority, schemas, and hard bounds immutable.
3. Run baseline and candidate against the same replayable cases. Grade states (per-node output), edges
   (branches fired, loop iterations, retries, evaluator `continue` rate, rounds without new validated
   output), outcome, cost, and latency.
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

The envelope is exact: `succeeded` carries no other key, and `partial`/`failed` carry only a
nonblank `reason`. Make the schema match so a wrong envelope is rejected in-session:

```jsonc
"outcome": { "type": "object", "additionalProperties": false, "required": ["status"],
  "properties": { "status": { "enum": ["succeeded", "partial", "failed"] }, "reason": { "type": "string", "pattern": "\\S" } },
  "allOf": [
    { "if": { "properties": { "status": { "const": "succeeded" } } }, "then": { "not": { "required": ["reason"] } } },
    { "if": { "properties": { "status": { "enum": ["partial", "failed"] } } }, "then": { "required": ["reason"] } }
  ] }
```

A skipped source node yields no envelope, so read the outcome from a node that runs on
every path.

## Authoring steps

1. Write the graph (inline, `.graph.json`, or `.graph.yaml`), keeping ids and dependencies explicit.
2. Run it — the tool validates first, so a shape error comes back before any cost.
3. Watch `/agents → Graph runs`: nodes are grouped by stage with live status;
   conditional edges show which branch fired; expanded nodes appear as they insert.
4. Depend only on validated structured output (`outputSchema` + `ValueRef`), never
   on an agent's prose.
5. Promote a proven inline graph to `agent-graphs/<name>.graph.json` or `.graph.yaml`.
