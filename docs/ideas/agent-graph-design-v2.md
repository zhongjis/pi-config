# Agent Graph Design for Pi Subagents

Status: idea

Non-binding design note for replacing the `SubagentWorkflow` script runtime in `extensions/subagents` with a typed, graph-first runtime on XState. Section 1 (the runtime and the `agent_graph` tool) is the subject of the initial work. Section 2 (the reusable workflow portfolio) is a **deferred future proposal** — read the banner there before treating any of it as planned.

The graph is the product-level abstraction; XState is the execution substrate.

Goals:

1. Replace self-maintained actor lifecycle, cancellation, transitions, and inspection with XState, so the harness maintains a typed graph plus a small scheduler instead of a bespoke worker runtime.
2. Make a workflow's topology explicit, typed, inspectable, and renderable in a graph monitor.

The graph model must support both saved graphs and ad-hoc graphs generated for a single task.

## Relationship to the current runtime

Settled decisions that scope this work:

- **Pure-data graph, no worker thread.** The graph IR is data, not code. No user-authored JavaScript runs, so the runtime needs no worker-thread sandbox and no `terminate()` kill switch; XState actors run in the host process. This retires the current model of a JavaScript workflow script executed in a `node:worker_threads` Worker.
- **No `action` node.** No graph node runs arbitrary shell or filesystem logic from graph data. Deterministic host checks stay as node **validation policy** — a gate command bound to a node's completion and authorized separately (§1.5) — which is the only place a host command runs.
- **Modes are out of scope.** Fu Xi / Hou Tu / Kua Fu are Mode Agents (prompt personas plus the `handoff` extension), not workflows. They are not migrated here; Section 2 is a separate, deferred proposal.

Already shipped and kept (ported onto the new runtime, not reinvented): typed structured output (`agent({schema})` → JSON Schema validation), durable in-session replay/resume (journal + stable keys), saved version-controlled workflow files, explicit `outcome` envelopes, and a progress monitor (today a tree, to become a graph).

Retired with the script runtime: the current real consumers `workflows/deep-research.js` and `workflows/last30days.js`. They are out of scope and safe to discard or deprecate — no port is required before the script runtime is deleted (§2.8).

---

# 1. Tool Revamp Design

## 1.1 Rename `SubagentWorkflow` to `agent_graph`

`SubagentWorkflow` describes an implementation detail. The tool will no longer be limited to subagents or script execution; it will execute typed graphs containing agent nodes, gates, conditions, subgraphs, and expansion nodes.

Use one public execution tool:

```ts
agent_graph({
  graph: "fuxi/ulw-plan",
  input: {
    request: "..."
  }
})
```

It should also accept an inline graph:

```ts
agent_graph({
  graph: {
    nodes: { /* ... */ },
    edges: [ /* ... */ ],
    outputs: { /* ... */ }
  },
  input: {
    request: "..."
  }
})
```

The two forms should share the same runtime:

```text
agent_graph
    |
    +-- saved graph reference
    |      graph: "houtu/execute-plan"
    |
    +-- inline graph
           graph: { nodes, edges, ... }
```

Avoid separate execution tools for saved workflows, dynamic workflows, parallel agents, or pipelines. They are all graph executions.

## 1.2 Make the graph IR the stable contract

Do not use XState machine definitions as the persisted workflow format. XState statecharts model runtime state transitions; the product needs a dependency and dataflow graph.

Define a product-level graph IR:

```ts
interface AgentGraph {
  id?: string;
  name?: string;
  version?: number;

  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;

  nodes: Record<NodeId, GraphNode>;
  edges: GraphEdge[];
  outputs?: Record<string, ValueRef>;
}
```

The same graph should drive execution, persistence, validation, and visualization:

```text
                 AgentGraph
                    |
       +------------+------------+
       |            |            |
       v            v            v
   validation    XState       monitor
                  runtime
```

This keeps the public graph format independent of XState and makes future runtime replacement possible.

## 1.3 Node types

Start with a small set of node types.

### Agent node

Runs a Pi subagent and returns a typed result.

```ts
interface AgentNode {
  type: "agent";
  agent: string;
  prompt: Template;
  input?: Record<string, ValueRef>;
  outputSchema?: JsonSchema;
  validation?: ValidationPolicy;
  retry?: RetryPolicy;
  resources?: string[];
}
```

### (No action node)

Deterministic host logic — shell commands, filesystem checks, tests — is intentionally **not** a node type. A graph node must never run arbitrary shell or filesystem operations from graph data. Deterministic checks run as node **validation policy** instead (a gate command bound to a node's completion, authorized separately); see §1.5.

### Human gate node

Pauses the graph until a person approves, rejects, edits, or supplies required data.

```ts
interface HumanGateNode {
  type: "human_gate";
  prompt: Template;
  input?: Record<string, ValueRef>;
  outputSchema: JsonSchema;
}
```

Human gates must be durable. A process restart must not lose the waiting state.

This is **new persistence scope**: the current runtime's resume is same-session only (roughly 30-minute retention within the parent session). Durable-across-restart waiting state is additional work, not a property the existing journal provides.

### Subgraph node

Invokes a reusable graph as a node.

```ts
interface SubgraphNode {
  type: "graph";
  graph: string;
  input?: Record<string, ValueRef>;
}
```

This is the main composition mechanism for reusable workflows.

### Expand node

Adds a validated `GraphFragment` to the current run graph.

```ts
interface ExpandNode {
  type: "expand";
  source: ValueRef; // must resolve to GraphFragment
  namespace?: string;
}
```

This supports plans whose concrete task topology is only known at runtime.

## 1.4 Typed outputs are mandatory for control flow

A node may emit prose for display, but graph logic should depend only on validated structured output.

Example review node:

```json
{
  "type": "agent",
  "agent": "reviewer",
  "outputSchema": {
    "type": "object",
    "properties": {
      "approved": { "type": "boolean" },
      "issues": {
        "type": "array",
        "items": { "type": "string" }
      }
    },
    "required": ["approved", "issues"],
    "additionalProperties": false
  }
}
```

Downstream nodes consume:

```text
review.output.approved
review.output.issues
```

They do not parse the reviewer's natural-language response.

`review.output.approved` is display shorthand for a `ValueRef`. The canonical, serializable form used by edges and conditions is `{ node: "review", path: "$.approved" }` (JSONPath into that node's validated output). One reference, two renderings; the structured form is authoritative because conditions must serialize.

## 1.5 Validation belongs in node completion

An agent finishing its turn does not mean the graph node completed successfully.

Use this lifecycle:

```text
blocked
   |
   v
 ready
   |
   v
running
   |
   v
validating
   |\
   | +-- invalid --> retry / repair / fail
   |
   +---- valid ----> completed
```

Support three validation classes:

1. **Schema validation**: output matches the declared JSON Schema.
2. **Deterministic validation**: host checks such as command exit status, file existence, test result, or invariant checks.
3. **Agent validation**: model-based review implemented as another graph node, not hidden inside the runtime.

This keeps the runtime deterministic where possible and makes model-based checks visible in the graph.

## 1.6 Conditions should be declarative

Do not bring arbitrary JavaScript conditions back into the runtime. Use a small serializable expression model.

```ts
type Condition =
  | { eq: [ValueRef, JsonValue] }
  | { ne: [ValueRef, JsonValue] }
  | { gt: [ValueRef, number] }
  | { gte: [ValueRef, number] }
  | { lt: [ValueRef, number] }
  | { lte: [ValueRef, number] }
  | { exists: ValueRef }
  | { and: Condition[] }
  | { or: Condition[] }
  | { not: Condition };
```

Example:

```json
{
  "from": "review",
  "to": "fix",
  "when": {
    "eq": [
      { "node": "review", "path": "$.approved" },
      false
    ]
  }
}
```

The condition language should remain deliberately small until real use cases require more.

## 1.7 Allow cycles; do not restrict the model to DAGs

The monitor can still present most workflows as DAG-like structures, but the execution model must support loops.

Examples:

```text
implement -> review -> approved -> done
              |
              +-- rejected -> fix -> review
```

and:

```text
plan -> critique -> revise -> critique
                  ^            |
                  +------------+
```

Protect loops with explicit limits:

```ts
loopPolicy: {
  maxIterations: 3
}
```

The public abstraction should therefore be `AgentGraph`, not `AgentDAG`.

## 1.8 Dynamic graph expansion

Dynamic graph expansion replaces generated orchestration JavaScript.

An agent may return:

```ts
interface GraphFragment {
  nodes: Record<NodeId, GraphNode>;
  edges: GraphEdge[];
  outputs?: Record<string, ValueRef>;
}
```

Before insertion, the runtime validates:

- schema correctness;
- unique node IDs within the namespace;
- edge references;
- allowed node types and capabilities;
- loop limits;
- resource declarations;
- graph size limits;
- nesting depth;
- optional policy restrictions.

The runtime then inserts the fragment atomically into the current `RunGraph`.

This creates two graph concepts:

```text
GraphDefinition
    reusable template stored on disk

RunGraph
    concrete graph for this execution after expansion
```

The monitor always displays the `RunGraph`.

## 1.9 XState responsibilities

Use XState for lifecycle mechanics, not graph persistence or domain semantics.

XState should own:

- workflow actor lifecycle;
- node actor lifecycle;
- legal state transitions;
- invocation lifetime;
- `AbortSignal` propagation;
- failure propagation;
- inspection events;
- actor snapshots;
- parent/child supervision.

The Pi graph layer should own:

- graph IR;
- dependency readiness;
- conditions;
- typed input/output wiring;
- schema validation;
- dynamic expansion;
- global concurrency;
- resource admission;
- cache/reuse policy;
- domain-specific events and metadata.

The target runtime shape is:

```text
                     agent_graph
                          |
                          v
                    AgentGraph IR
                          |
             +------------+------------+
             |                         |
             v                         v
       WorkflowActor                monitor
          XState
             |
        SchedulerActor
             |
      +------+------+------+
      v      v      v      v
    Node   Node   Node   Node
    Actor  Actor  Actor  Actor
      |      |      |      |
      +------+------+------+
             |
             v
        WorkflowHost
             |
             v
         Pi agents
```

## 1.10 Scheduler responsibilities

Keep a small custom scheduler. XState should not be forced to represent dependency scheduling or resource capacity.

A node becomes runnable when:

1. all required predecessor dependencies are resolved;
2. at least one incoming conditional path activates the node, if applicable;
3. its declared resources have capacity;
4. the global concurrency limit has capacity.

The scheduler needs only a few concepts:

```text
pending -> ready -> running -> settled
```

and:

```text
READY(node)
NODE_SETTLED(node)
RESOURCE_ACQUIRED(node)
RESOURCE_RELEASED(node)
PAUSE
RESUME
```

Pause should stop new admission while allowing already-running nodes to finish.

## 1.11 Resource constraints

Dependency independence does not imply safe execution in one checkout.

Nodes may declare resources:

```ts
resources: ["workspace:main"]
```

Resource capacities are configured separately:

```ts
{
  "workspace:main": { "capacity": 1 },
  "network": { "capacity": 8 }
}
```

Later, Houtu could allocate isolated worktrees:

```text
workspace:worktree:T1
workspace:worktree:T2
workspace:worktree:T3
```

This allows parallel implementation when isolation exists without making unsafe shared-workspace execution the default.

## 1.12 Monitoring model

The monitor should consume the graph plus runtime state directly:

```ts
interface RunGraphState {
  graph: RunGraph;
  nodes: Record<NodeId, NodeRuntimeState>;
}
```

Each node can expose:

```ts
interface NodeRuntimeState {
  status:
    | "blocked"
    | "ready"
    | "queued"
    | "running"
    | "validating"
    | "completed"
    | "failed"
    | "skipped";

  attempt: number;
  startedAt?: number;
  endedAt?: number;
  agentId?: string;
  model?: string;
  tokenUsage?: number;
  output?: unknown;
  validation?: unknown;
}
```

The UI should show both topology and execution state. Conditional edges should show whether their condition evaluated true or false. Dynamic expansion should appear immediately as new nodes and edges.

XState inspection can supply lifecycle events, while the graph runtime adds domain data such as tokens, model, validation results, agent records, and output previews.

## 1.13 Saved graph storage

Store reusable graphs as normal project or user configuration files. For example:

```text
.pi/
  agent-graphs/
    fuxi/
      ulw-plan.graph.json
    houtu/
      execute-plan.graph.json
    kuafu/
      ulw.graph.json
    shared/
      context-gather.graph.json
      review-loop.graph.json
```

Do not require a separate CRUD tool at first. Pi can create and edit graph files using normal file tools, validate them, then execute them through `agent_graph`.

A graph-engineering skill can teach the main agent how to author, validate, compose, and debug these files.

---

# 2. Reusable Workflow Proposal

> **Status: deferred proposal — not part of the initial work.** Everything in Section 2 is exploratory. Fu Xi / Hou Tu / Kua Fu are **Mode Agents** today (prompt personas plus the `handoff` extension), **not** workflows, and no `fuxi/ulw-plan`, `houtu/execute-plan`, or `kuafu/ulw` workflow exists. This section sketches a possible future in which some mode sub-steps *call* saved graphs; read every "workflow" below as "possible future graph" and every mode name as the current Mode Agent it might one day delegate to. Nothing here is committed, and the Section 1 runtime work does not depend on it.

The main design question is not how many top-level workflows to create. It is where to draw reusable subgraph boundaries.

The proposal is:

- expose a small number of user-facing workflows;
- factor repeated capabilities into reusable subgraphs;
- compose subgraphs inside one durable run;
- use dynamic expansion when the concrete task graph is only known after analysis or planning.

## 2.1 Shared reusable subgraphs

Start with these shared graphs.

### `shared/context-gather`

Purpose: collect and structure repository and task context before planning or implementation.

Possible shape:

```text
input
  |
  +--> repo-map --------+
  |                     |
  +--> relevant-code ---+--> synthesize-context
  |                     |
  +--> tests -----------+
  |                     |
  +--> docs/history ----+
```

Output:

```ts
interface GatheredContext {
  summary: string;
  relevantFiles: string[];
  constraints: string[];
  unknowns: string[];
  evidence: EvidenceRef[];
}
```

This should be shared by Fuxi and Kuafu and may also be useful to Houtu for tasks whose plan lacks enough implementation context.

### `shared/review-loop`

Purpose: review an artifact and optionally iterate until accepted or a bounded retry count is reached.

```text
artifact
   |
   v
 review
   |
   +-- approved --> output
   |
   +-- rejected --> revise --> review
```

The artifact may be a plan, implementation result, architecture proposal, or other typed value. The graph should accept schemas or typed adapters rather than hard-code one artifact type.

### `shared/work-verify`

Purpose: run deterministic and model-based verification after implementation.

```text
implementation
     |
     +--> tests --------+
     +--> static-check -+--> summarize-verification
     +--> review -------+
```

Output should distinguish deterministic failures from agent review concerns.

## 2.2 Fuxi: `fuxi/ulw-plan`

Recommendation: keep one public Fuxi planning workflow, but compose it from reusable stages.

Do not require the caller to invoke separate requirement-gathering, analysis, and planning workflows manually. They are parts of one planning transaction and share state, evidence, approvals, and revision history.

Suggested shape:

```text
request
   |
   v
shared/context-gather
   |
   v
requirements/intake
   |
   +-- clear ----------------------------+
   |                                     |
   +-- unclear --> human clarification --+
                                         |
                                         v
                                   plan-author
                                         |
                                         v
                                   gap-analysis
                                         |
                                         v
                                      review
                                      /    \
                                approve    revise
                                   |          |
                                   |          +--> review
                                   v
                                 plan
```

For large architecture work, `requirements/intake` or `plan-author` can dynamically expand additional analysis lanes:

```text
              +--> architecture analysis --+
context ------+--> dependency analysis -----+--> synthesis
              +--> risk analysis -----------+
              +--> implementation research -+
```

### Why one public flow

Requirement gathering, analysis, and plan generation are tightly coupled. Splitting them into separate top-level runs would create unnecessary handoff state and make the monitor show several runs for one conceptual planning operation.

### Where to split internally

Use reusable subgraphs for:

- context gathering;
- requirement clarification;
- architecture analysis;
- plan review;
- bounded revise/review loops.

This preserves modularity without fragmenting the user experience.

### Required graph features proven by Fuxi

Fuxi stress-tests:

- parallel analysis;
- human gates;
- conditions;
- typed output;
- bounded loops;
- subgraphs;
- durable pause/resume;
- runtime expansion for larger analysis sets.

If the graph model handles Fuxi cleanly, it is already richer than a simple DAG scheduler.

## 2.3 Houtu: `houtu/execute-plan`

Houtu is the strongest case for dynamic graph expansion.

The reusable top-level graph should not encode implementation task topology because the topology comes from the plan.

Suggested shape:

```text
plan
  |
  v
parse-plan
  |
  v
validate-plan
  |
  v
plan-to-graph
  |
  v
GraphFragment
  |
  v
EXPAND
  |
  v
concrete implementation graph
  |
  v
shared/work-verify
  |
  v
result
```

Example generated fragment:

```text
T1 --------> T3 ----> T5
  \          ^
   \         |
T2 ----------+

T4 -----------------> T5
```

Each task node should have typed inputs and outputs. Dependencies come from the plan, not from hard-coded workflow structure.

### Houtu should validate before expansion

`plan-to-graph` should produce a `GraphFragment`, not mutate the runtime directly. The runtime then validates the fragment before insertion.

Validation should check:

- every task has a stable ID;
- all dependencies reference existing tasks;
- required inputs exist;
- cycles are intentional and bounded;
- declared resources are valid;
- task count and nesting depth stay within limits;
- implementation nodes have appropriate agent/tool capabilities.

### Workspace concurrency

Houtu also proves the need for resource scheduling.

Without worktree isolation:

```text
T1 resources: ["workspace:main"]
T2 resources: ["workspace:main"]
```

so they serialize even if their dependency graph allows parallel execution.

With isolated worktrees:

```text
T1 resources: ["workspace:worktree:T1"]
T2 resources: ["workspace:worktree:T2"]
```

and the scheduler can run them concurrently.

### Required graph features proven by Houtu

Houtu stress-tests:

- runtime graph expansion;
- graph-fragment validation;
- dependency scheduling;
- resource scheduling;
- typed task contracts;
- task-level retry;
- independent branch execution;
- final verification;
- graph monitoring of dynamically added tasks.

Dynamic expansion is therefore a core primitive, not an optional future feature.

## 2.4 Kuafu: `kuafu/ulw`

Recommendation: expose one public Kuafu workflow, but split context gathering and task execution internally.

The caller should not need to decide whether a request deserves one agent, several agents, or a generated work graph.

Suggested shape:

```text
request
   |
   v
shared/context-gather
   |
   v
classify-work
   |
   +-- simple --> direct-work ------+
   |                                |
   +-- complex --> design-work-graph|
                     |              |
                     v              |
                GraphFragment       |
                     |              |
                   EXPAND            |
                     |              |
                     +--------------+
                                    |
                                    v
                            shared/work-verify
                                    |
                                    v
                                  result
```

### Why context gathering should be a reusable subgraph

Context gathering appears in both planning and implementation flows, but it should not become a separate user-facing invocation. It is a reusable capability, not a user-level workflow boundary.

Keeping it as `shared/context-gather` gives three benefits:

1. Fuxi and Kuafu use the same evidence format.
2. Improvements to repository discovery benefit both flows.
3. The monitor still shows context gathering as part of the current run.

### Ad-hoc work graphs

For complex tasks, Kuafu should produce a typed `GraphFragment` describing the task-specific execution strategy.

Examples:

```text
inspect backend ----+
                    +--> implement --> test
inspect frontend ---+
```

or:

```text
research A --+
research B --+--> synthesis --> implementation --> review
research C --+
```

This replaces free-form orchestration scripts with a validated graph that remains visible, inspectable, and reusable if promoted to a saved graph later.

### Promotion path

A useful workflow should be promotable from ad-hoc to reusable without rewriting it:

```text
inline GraphFragment
       |
       | proven useful repeatedly
       v
saved AgentGraph
       |
       v
.pi/agent-graphs/shared/<name>.graph.json
```

That gives the graph-engineering tool a natural learning loop: invent a graph for one task, inspect how it behaves, then formalize successful structures as reusable workflows.

## 2.5 Proposed workflow portfolio

The initial portfolio should stay small:

```text
shared/context-gather
shared/review-loop
shared/work-verify

fuxi/ulw-plan
houtu/execute-plan
kuafu/ulw
```

Composition:

```text
                    shared/context-gather
                      ^               ^
                      |               |
               fuxi/ulw-plan      kuafu/ulw
                      |               |
               shared/review      dynamic work graph
                                      |
                                      v
                                shared/work-verify

houtu/execute-plan
       |
       v
  plan-to-graph
       |
       v
  dynamic work graph
       |
       v
shared/work-verify
```

Avoid creating many top-level workflows until repeated usage proves that a stage has independent value to callers.

## 2.6 Graph engineering as a first-class workflow

The long-term product is not only a graph runner. It is a system for engineering agent workflows.

A graph-engineering capability should help Pi:

1. inspect an existing graph;
2. identify repeated structures;
3. extract reusable subgraphs;
4. define or tighten node schemas;
5. add conditions and validation;
6. test the graph against representative inputs;
7. compare run traces;
8. promote successful ad-hoc graphs into saved workflows.

The graph itself should remain ordinary version-controlled data. That makes changes reviewable and allows workflow evolution to use normal repository practices.

## 2.7 Design decisions to validate with implementation

The first prototype should answer these questions before the schema grows further:

1. Can XState node actors cleanly replace current retry, skip, abort, and pause logic?
2. Can `RunGraph` expansion happen atomically while nodes are already running?
3. Can a dynamically expanded graph preserve stable node identities across resume/retry?
4. Is the proposed condition language sufficient for Fuxi review loops and Kuafu routing?
5. Do JSON Schema node contracts create too much prompt/runtime overhead?
6. How should subgraph inputs and outputs be namespaced?
7. What should happen when a graph expansion introduces a dependency on a node that already completed?
8. Which XState snapshot data is worth persisting, and which state should remain in the graph journal?
9. What minimum resource model is needed for Houtu before adding worktree-aware execution?

The first implementation target should be one representative flow, not the whole migration. `fuxi/ulw-plan` is the best control-flow test; `houtu/execute-plan` is the best dynamic-expansion test. Implementing those two should expose most weaknesses in the model before Kuafu depends on it.

## 2.8 Recommended implementation order

Use this sequence:

```text
1. AgentGraph schema + validator
2. RunGraph model + monitor rendering
3. XState NodeActor
4. WorkflowActor + small scheduler
5. typed outputs + schema validation
6. declarative conditions
7. human gate node
8. reusable subgraph node
9. GraphFragment + expand node
10. discard the two out-of-scope script workflows (`deep-research.js`, `last30days.js`)
11. remove legacy script runtime
12. (deferred, Section 2) Fu Xi / Hou Tu / Kua Fu integration — not part of the initial work
```

The two current script workflows are out of scope and are discarded, not ported, so nothing external gates removing the legacy runtime once Section 1 reaches parity for in-scope use. The hard case the graph model must still handle on its own terms is independent fan-out plus in-graph synthesis and bounded loops — the logic that had no `action` node to land on and must map onto agent nodes, conditions, and typed wiring instead.

---

## Summary

The recommended design is a typed, composable `AgentGraph` system with XState underneath it.

`agent_graph` becomes the single execution tool. Saved and inline graphs use the same runtime. Typed node outputs drive conditions and downstream inputs. XState owns actor lifecycle and cancellation. A small scheduler owns dependency and resource admission. `GraphFragment` expansion replaces generated orchestration scripts when task topology is discovered at runtime.

The graph IR is pure data with no embedded code, so the runtime drops the worker-thread sandbox and runs XState in-process. There is no `action` node; deterministic checks are node validation policy. The reusable-workflow portfolio (Section 2), and any Fu Xi / Hou Tu / Kua Fu integration, are deferred proposals that do not gate the initial runtime work.
