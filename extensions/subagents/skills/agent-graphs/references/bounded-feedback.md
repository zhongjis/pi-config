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

Reasons: `sufficient`, `iteration limit`, `item limit`, `deadline/spend limit`, `no progress`, `evaluator failure`, `materialization failure`, `cancellation`, `skipped before admission`. `skipped before admission` is only for a scheduler skip that was never admitted, with zero attempts and no output. Child failures remain evidence; evaluator exhaustion permits partial synthesis. Materialization failure fails the node and does not activate downstream synthesis. `RunGraphResult.feedback` retains typed terminal metadata even on failure/cancellation. Workflow results with feedback use `{ outputs, feedback }`, where `feedback` is keyed by the authored bounded-feedback node key; this also preserves terminal metadata when a failed node cannot populate declared outputs. Runs without feedback retain their existing result shape.

V2 child results add `instanceId`, `nodeKey`, `binding`, `ordinal`, and applicable `parentInstanceId`, `iteration`, `itemIndex`. `nodeId` remains the generated scheduler binding, never a UUID alias.

## Persistence and observation

- The low-level `runGraph` API requires a synchronous `onCheckpoint(state, effectiveGraph)` writer for v2. The workflow runtime supplies the filesystem writer and stable run ID. Throwing from the writer stops dispatch and retains the previous valid checkpoint.
- Nested saved graphs checkpoint their effective graph, input and state inside the parent's atomic checkpoint. Each invocation has its own stable run scope; completed invocation history and run-scoped recursive monitor-ordinal mappings remain durable. This lets existing v1 portfolio callers invoke a saved v2 feedback graph.
- Snapshot v2 includes the effective graph, scheduler attempts/results, a run-scoped UUID-v4 materialization manifest and feedback transitions. A strictly validated v1 snapshot upgrades once, atomically, before dispatch. Restore checks executable fanout children, ownership, outcomes and terminal consistency; it re-authorizes all persisted nested graphs before task creation, leases or writes. Invalid snapshots remain untouched with visible errors.
- Workflow snapshot IDs follow `^agr_[a-z0-9-]{6,}$` and must equal their filename stem. Symlinked `.pi`, checkpoint directories, snapshots and owner files are rejected. This is containment for persisted data, not a filesystem sandbox against concurrent same-user mutation.
- Fresh runs persist `runtime.startedAt`; low-level `runGraph` accepts an injected `now` clock (default `Date.now`). Restore retains that start, elapsed suspension time, cost totals, accounting gaps and repair budgets; fresh replay starts anew. Replacement cannot rewrite the start, roll back budget-check time or reported costs, or erase missing-accounting evidence. Older unbudgeted v2 snapshots may omit the start; deadline-configured snapshots may not, and restore never invents it.
- Continuation intent is durable before successor UUID allocation; the entire successor manifest is durable before monitor publication or dispatch. Retry/restore reuse IDs. A fresh run/replay allocates new IDs.
- Atomic replacement uses file sync, rename and supported directory sync. Under one write lock, revision and append-only transition checks preserve existing UUIDs, provenance, executable definitions, settled outcomes and iteration history.
- Lifetime run leases prevent live competing dispatch owners. Lock metadata carries a nonce and, on Linux, boot/process-start identity to distinguish PID reuse. Atomic hard-link publication and recursive owner recovery reclaim orphan recovery guards. Corrupt metadata or unavailable liveness evidence fail closed; without process-start support, a live/reused PID requires operator inspection rather than unsafe reclamation. The filesystem must support hard links.
- Reload, session switch and shutdown preserve restorable active state. Explicit cancellation records terminal partial results; workflow completion deletes its checkpoint, and resume removes an already-terminal cancellation without relaunching it. Evaluator attempt numbers and remaining repair budgets survive interruption.
- Checkpoints provide structural consistency and current-policy authorization, not signed proof of past execution or exactly-once external effects. A dispatched action may repeat after a crash with the same instance ID and another recorded attempt.
- V2 monitors use one materialization-ordered roster, name-first labels and iteration/item context. Binding keys and UUIDs remain in detail/debug data. Future iterations are absent until committed.
