# Awaited Dynamic Agent-Graph Expansion

Status: shipped

Owner: `extensions/subagents` graph runtime

Related: [Reusable Agent-Graph Workflow Portfolio](agent-graph-reusable-workflows.md) · [Herdr Agent-Graph Panel Presentation](herdr-agent-graph-presentation.md) · authoring skill `extensions/subagents/skills/agent-graphs/SKILL.md`

## Problem

The graph runtime can splice a model-authored `GraphFragment` with `expand`, but it cannot express a typed list of work items as visible child nodes and await their combined results. `context-gather` therefore declares ten possible source lanes up front even when a request needs one. Herdr shows unused lanes, and a second evidence round depends on another fixed set of nodes.

The runtime needs one small, reusable primitive that materializes only requested tasks, runs each task in a fresh Subagent, waits for every task to settle, and returns successes and failures as typed data.

## Decision

Add a `fanout` graph node. Preserve valid `expand` behavior; both `fanout` and legacy `expand` insertion must enforce the 500-node effective-run ceiling before inserting any nodes. This is a safety-backstop correction, not a change to valid expansion semantics.

A `fanout` resolves a typed item array, maps each item to an agent selector through an author-declared dispatch table, creates one ordinary dynamic `agent` node per item, and remains a running barrier until all owned children settle. The parent then completes with ordered, all-settled results.

`fanout` is generic. It does not know context-gather sources, evaluator semantics, or graph topology. Research children receive only their task and explicitly wired inputs. The evaluator returns typed `{ sufficient, gaps, tasks }`; the saved graph, not a research child, owns control flow.

## IR Contract

```ts
interface FanoutNode {
  type: "fanout";
  items: ValueRef;
  itemSchema: JsonSchema;
  dispatch: {
    path: string;                  // JSONPath relative to one item
    cases: Record<string, string>; // resolved value -> agent selector
  };
  prompt: Template;
  input?: Record<string, ValueRef>;
  outputSchema?: JsonSchema;       // each child's structured output
  phase?: {
    index: number;                 // zero-based monitor group
    title: string;
  };
}
```

The prompt may use `${item}` plus keys declared in `input`. `${item}` expands to the complete JSON item. The dispatch table has no default: an unknown value is an authoring or task error, never an implicit agent choice.

`itemSchema` must have an object root. The runtime validates every item before creating any child. `outputSchema`, when present, uses the same structured-output contract as an `agent` node.

A completed fanout exposes:

```ts
interface FanoutResult {
  results: Array<{
    nodeId: string;
    index: number;
    item: JsonValue;
    status: "completed" | "failed" | "skipped";
    attempt: number;
    output?: unknown;
    error?: string;
  }>;
}
```

Results preserve input order, regardless of completion order.

## Execution Contract

### Atomic materialization

The driver resolves and validates the complete item list before insertion. It rejects a non-array, an invalid item, a dispatch miss, an ID collision, or an expansion that would exceed the existing 500-node run ceiling without inserting any child.

Generated IDs are deterministic and namespaced by the fanout node ID: `<fanout-id>:item:<index>`. Separate round nodes therefore provide separate namespaces. A loop target must not reach a `fanout` or `bounded_feedback` barrier through normal edges (including guarded edges), directly or transitively. Expansion checks the combined effective topology before insertion; bounded repeated work uses explicit fanout nodes per round or `bounded_feedback`.

### Awaited children

The driver marks the fanout parent running, inserts its children, and registers them with the monitor before their first state update. Children have no scheduler dependency on the running parent, which avoids a barrier deadlock. The parent owns the child IDs and settles only when every child is terminal.

Each generated child follows the ordinary agent path: concurrency and resources apply, delegation is preflighted, structured output is validated, and `NodeHost.spawnAgent` creates a fresh Subagent. Direct graph runs expose child controls at stable monitor indices; nested subgraph children remain inspectable but read-only. No continuation or hidden conversation state is added.

### Failure collection

A generated child's `failed` or `skipped` state remains visible and is copied into the parent result. Collected child failures do not fail the whole graph. Materialization errors fail the fanout parent because no valid collection exists.

Downstream evaluators must inspect each result's `status`, `output`, and `error`. They preserve missing evidence as gaps or unknowns instead of treating absent output as success.

### Attempts and loops

`NodeRun.attempt` counts graph-level starts. The scheduler records whether a later attempt came from `user-retry` or a bounded `loop`; first attempts have no reason. Internal schema/gate retries inside one agent actor remain one graph attempt.

Herdr renders `attempt N` with its reason. Evidence rounds are phase metadata, not attempts.

## Persistence and Resume

Snapshots retain the effective graph, including generated agent definitions, plus collection ownership in scheduler state. A checkpoint taken while a fanout is active therefore preserves:

- parent-to-child ownership and input order;
- generated IDs and definitions;
- child states, attempts, outputs, and failures;
- the parent barrier state.

On restore, completed children stay settled. In-flight children become pending and start fresh through the normal host. The parent reattaches to its existing collection instead of creating duplicate children. Older snapshots without collection metadata remain valid. Materialized child prompts retain literal placeholder-looking item data on restore; only provenance-verified collection children bypass authored-template placeholder validation, and their generated definitions are still regenerated and checked.

The gate-waiting callback receives the effective graph and scheduler state so the existing version-1 snapshot envelope can store the materialized topology.

## Delegation and Validation

Graph validation checks:

- `items` and `input` ValueRefs;
- object-root `itemSchema` and optional object-root `outputSchema`;
- dispatch JSONPath, non-empty cases, and non-empty agent selectors;
- prompt placeholders, with `${item}` reserved and all others backed by `input`;
- non-negative phase index and non-empty phase title;
- no loop target reaching a fanout or bounded-feedback barrier over normal edges, including after expansion.

Delegation preflight checks every distinct selector in `dispatch.cases`, including fanouts inside resolvable subgraphs. Generated children do not introduce selectors that were absent from the validated graph.

The existing 500-node and 1,000-run safety backstops remain authoritative. There is no separate task-count budget.

## Monitor Contract

`runGraph` emits dynamic-node registration before the first node update. Registration includes the node definition, display dependencies, and inherited phase metadata.

`GraphRunReporter` assigns each dynamic node a monotonic, collision-free index; updates task totals; stores its agent selector and prompt; and updates dependency/dependent maps. Static nodes keep their computed stage groups. Generated children use the fanout's phase group, such as `Round 1/2`.

Herdr must show:

- only materialized research children;
- the correct agent selector, effective model, record, dependencies, and stable index;
- `Round 1/2` or `Round 2/2` for research children;
- `attempt N · user retry` or `attempt N · loop` when applicable;
- retained child inspection under existing live/history privacy and size limits.

Fanout children are never labelled resumed because this change adds no Subagent continuation.

## `context-gather`

The saved graph has two explicit evidence rounds:

1. `research-round-1` fans out the caller's `tasks`.
2. `evaluate-round-1` returns `{ sufficient, gaps, tasks }`.
3. If sufficient, synthesize. Otherwise, `research-round-2` fans out only evaluator tasks.
4. `evaluate-round-2` assesses the combined evidence, then synthesize.

The two explicit fanouts make the ceiling structural. There is no graph back-edge and no third round.

Source dispatch is:

- `project` -> `chengfeng`;
- `platform`, `upstream`, `work-records`, and `practice` -> `wenchang`.

Callers still check applicable Skills before supplying tasks. Skills outrank remote `practice` research, and callers do not add `practice` by default.

Each evaluator sees the original request, requested tasks, prior evidence, and all-settled results. `synthesize` preserves the existing `GatheredContext` fields: `summary`, `relevantFiles`, `constraints`, `unknowns`, `evidence`, and `conflicts`.

## Acceptance Criteria

1. A fanout with two items creates exactly two dynamic agent nodes and returns results in item order.
2. An empty item list completes with `{ results: [] }`.
3. One failed child does not stop or fail its sibling or parent; its error appears in the collection.
4. Invalid items, dispatch misses, collisions, and effective-node overflow fail atomically.
5. Every generated selector passes delegation preflight before the graph task starts.
6. A restored active fanout reuses generated IDs, retains settled children, and reruns only interrupted children.
7. Dynamic reporter registration gives each child a unique index, selector, dependencies, round, model, and conversation record.
8. Herdr distinguishes evidence round, loop rerun, and user retry.
9. `context-gather` creates no node for an unrequested source and never exceeds two evidence rounds.
10. A source absent from round one can appear in round two.
11. Focused unit tests, the portfolio test, typecheck, and a fresh Pi live run pass.

## Out of Scope

- Subagent continuation or resume-by-conversation.
- Model-authored raw graph fragments for context gathering.
- A general unbounded evaluator loop.
- Access-policy or approval machinery.
- Changes to valid legacy `expand` behavior beyond enforcing the effective-run node ceiling.
- Federated pause, skip, or retry controls for nodes inside recursively invoked subgraphs.
- Global concurrency, resource, node-run, or retry budgets shared across recursive subgraph schedulers.
