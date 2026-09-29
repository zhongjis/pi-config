# Version 2 bounded feedback

Use `version: 2` and a `bounded_feedback` node for repeated evidence gathering. Keep ordinary fanout for one collection. Unversioned and version-1 graphs retain their existing wiring and `FanoutResult.nodeId` contract.

A runnable schema fixture lives at `extensions/subagents/test/fixtures/bounded-feedback.graph.json` in the repository. Its input is `{ "tasks": [{ "source": "local", "task": "Find the relevant implementation" }] }`. Selectors must still pass the active delegation policy.

## Authoring contract

- Authored node-map keys, edges and ValueRefs remain stable strings (`NodeKey`). Optional `name` is presentation only and may duplicate.
- Required positive integer bounds: `maxIterations` (including the initial iteration), `maxItemsPerIteration`, `maxTotalItems`. Existing 500-node and 1000-node-run ceilings also apply before materialization/dispatch.
- `work` is a fixed `fanout` template with `items`, `itemSchema`, `dispatch`, `prompt`, and a required structured `outputSchema`. It may have normal input ValueRefs and a display name.
- `evaluator` is a fixed `agent` template with `agent`, `prompt`, optional normal input ValueRefs, name and retry policy. `${feedback}` is reserved: it contains all prior iterations, current all-settled results and unresolved gaps. Do not provide `evaluator.input.feedback` or `evaluator.outputSchema`; the runtime owns them. The injected decision output schema types `tasks[].item` to the work node's `itemSchema`, so each gap-closing `item` must satisfy that same work item schema.
- Bounded-feedback templates cannot be introduced through runtime fragments or used as loop targets. They do not permit evaluator-authored agents, edges or stages.
- Optional `deadline` is a positive safe-integer duration in milliseconds from the durable v2 run-start timestamp, not from each iteration or restore. Optional `spendLimit` is positive finite USD. Unknown fields, including budget aliases, are rejected.
- Budgets are checked before initial materialization, after evaluator completion before continuation intent, and again on restored intent before UUID allocation, materialization or dispatch. Reaching either limit returns `deadline/spend limit`, `partial: true`, preserved evidence and `exhaustedBounds` containing `deadline` and/or `spendLimit`.
- Spend sums authoritative child `AgentRecord.lifetimeCost` through `NodeSpawnResult.costUsd` and persisted `NodeRun.costUsd` across this region's work children and evaluator executions, including repair attempts. It never estimates from tokens or includes unrelated graph agents. If any settled execution lacks accounting, `exhaustedBounds` includes `spend accounting unavailable` and growth fails closed.
- These are admission/continuation bounds, not in-flight preemption or a guaranteed maximum bill: already-admitted agents and evaluator repairs may finish beyond a limit.

The evaluator must return exactly this decision shape:

```json
{
  "decision": "continue",
  "gaps": [{ "id": "missing-tests", "description": "Coverage remains unknown" }],
  "tasks": [{ "gapId": "missing-tests", "item": { "source": "local", "task": "Inspect the relevant tests" } }]
}
```

Each task must link to a declared gap and its `item` must satisfy the work item schema and fixed dispatch table. Gap IDs must be unique. `continue` requires at least one task. `sufficient` requires no tasks:

```json
{ "decision": "sufficient", "gaps": [], "tasks": [] }
```

Malformed decisions retry within the same evaluator instance under its retry policy. Exact repeated canonical task collections, or no newly distinct validated successful output, stop as `no progress`. Object-key order does not affect equality.

## Results and synthesis

The node output contains `reason`, `partial`, `iterations`, `gaps`, `counters: { iterations, totalItems }`, and `exhaustedBounds`. Every iteration retains tasks, work/evaluator IDs, all input-ordered child outcomes and its decision or evaluator error. Read the **whole** node output with `{ "node": "research", "path": "$" }` for downstream synthesis; do not select only the latest successful result.

Reasons: `sufficient`, `iteration limit`, `item limit`, `deadline/spend limit`, `no progress`, `evaluator failure`, `materialization failure`, `cancellation`, `skipped before admission`. `skipped before admission` is only for a scheduler skip that was never admitted, with zero attempts and no output. Child failures remain evidence; evaluator exhaustion permits partial synthesis. Materialization failure fails the node and does not activate downstream synthesis. `RunGraphResult.feedback` retains typed terminal metadata even on failure/cancellation. Graph run results with feedback use `{ outputs, feedback }`, where `feedback` is keyed by the authored bounded-feedback node key; this also preserves terminal metadata when a failed node cannot populate declared outputs. Runs without feedback retain their existing result shape.

V2 child results add `instanceId`, `nodeKey`, `binding`, `ordinal`, and applicable `parentInstanceId`, `iteration`, `itemIndex`. `nodeId` remains the generated scheduler binding, never a UUID alias.

## Persistence

Active v2 runs checkpoint and resume after reload or a session switch in the same session. Retry and restore reuse instance IDs. A dispatched action may repeat after a crash (not exactly-once) — make external effects idempotent. Storage, lease, and restore internals: [agent-graph-bounded-feedback.md](../../../../../docs/specs/agent-graph-bounded-feedback.md).
