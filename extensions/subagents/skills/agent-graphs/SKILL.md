---
name: agent-graphs
description: Author, validate, run, and debug typed agent graphs for the `agent_graph` tool. Use when building or editing a `.graph.json` graph or an inline graph, or when a task is a multi-step / branching / looping / parallel agent workflow.
---

You author **agent graphs**: typed, declarative graphs of agent work that the
`agent_graph` tool executes. A graph is data, not code — the runtime validates it
before anything runs, executes it via XState with a dependency scheduler, and
shows it live in `/agents → Workflows`.

Prefer a graph over ad-hoc `Agent` calls when the work has real structure:
dependencies, branching on a result, bounded retry/loops, parallel fan-out, a
human approval gate, or a reusable sub-workflow.

## Running a graph

```ts
agent_graph({ graph: "shared/review-loop", input: { task: "..." } })   // saved
agent_graph({ graph: { nodes: {...}, edges: [...], outputs: {...} }, input: {...} })  // inline
```

- **Saved graphs** live at `agent-graphs/<name>.graph.json` (namespaced with
  `/`, e.g. `shared/review-loop`). Author with normal file tools; no CRUD tool.
- The call returns a **task id immediately** and runs in the background; you are
  notified on completion. Do not poll. Watch it in `/agents → Workflows` (nodes
  grouped by stage, with pause / skip / retry).
- Invalid graphs are rejected **before** any node runs, with per-error messages.

## Graph shape (`AgentGraph`)

```jsonc
{
  "description": "Optional live-run purpose shown in /graph-runs",
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
- **human_gate** — pauses for a human decision; `outputSchema` is required (v1 UI is
  approve/reject, producing `{ "approved": boolean }`).
- **graph** — runs a saved subgraph and uses its `outputs` as this node's output.
  ```jsonc
  { "type": "graph", "graph": "shared/context-gather", "input": { "task": { "path": "$.task" } } }
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

## Resources

A node's `resources: ["workspace:main"]` are admitted only while under the
capacity passed to the run. Two nodes sharing a capacity-1 resource serialize
even when their dependencies would allow parallelism.

## Authoring workflow

1. Write the graph (inline or `.graph.json`), keeping ids and dependencies explicit.
2. Run it — the tool validates first, so a shape error comes back before any cost.
3. Watch `/agents → Workflows`: nodes are grouped by stage with live status;
   conditional edges show which branch fired; expanded nodes appear as they insert.
4. Depend only on validated structured output (`outputSchema` + `ValueRef`), never
   on an agent's prose.
5. Promote a proven inline graph to `agent-graphs/shared/<name>.graph.json`.
