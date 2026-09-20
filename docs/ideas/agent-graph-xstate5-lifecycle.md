# XState v5 Agent-Graph Lifecycle

Status: idea

This is a non-binding architecture note. The shipped [bounded-feedback specification](../specs/agent-graph-bounded-feedback.md) and [dynamic-expansion specification](../specs/dynamic-agent-graph-expansion.md) remain authoritative. Where this note conflicts with a shipped specification, the specification wins. It refines the direction in [Agent Graph Design for Pi Subagents](agent-graph-design-v2.md) without changing the public graph contract.

## Decision

Adopt XState v5 as the sole lifecycle authority for each graph run. The responsibility boundary is explicit:

- **XState owns “when and what happens next”:** lifecycle state, legal transitions, event serialization, supervision, pause/resume, retry transitions, cancellation, draining state, terminal selection, and the actor registry and hierarchy.
- **Panda owns “what the graph means and what must survive”:** `AgentGraph`, pure dependency and readiness calculation, domain rules, durable IDs, budgets, authorization, committed topology, the attempt/effect ledger, leases, and atomic persistence and validation.
- **Host adapters own “how external work runs and drains”:** agent, gate, and UI execution; abort signalling; cleanup; and drain acknowledgement.

Only one lifecycle authority exists. The target has no second imperative drive loop, parallel node-status map, manual completion race, custom parent-child supervision, or callback that mutates graph state. XState invokes Panda domain and persistence services and host adapters; neither service layer independently advances lifecycle state.

`AgentGraph` remains the public and persisted intermediate representation. XState machine definitions do not become the saved graph format. One root `GraphActor` owns the run lifecycle, with typed node and coordinator actors beneath it. Panda checkpoints remain authoritative for durable facts and recovery permission.

The installed dependency resolves to `xstate 5.33.2` (`extensions/subagents/package.json:66-68`; `pnpm-lock.yaml:1363,2609`). Current use is shallow: `node-actor.ts` defines promise logic with `fromPromise`, `run-graph.ts:421` creates one actor per agent node, and the custom loop in `run-graph.ts:766-870` drives readiness, controls, settlement, and shutdown. The migration replaces that lifecycle machinery incrementally; it does not rewrite `AgentGraph` or the dependency algorithm.

## Official XState conclusions

XState persistence snapshots can restore actor state. Actions that ran before persistence are not rerun, while active invocations restart after restoration. This is useful actor-state behavior, but it is not exactly-once workflow recovery and cannot replace Panda's durable checkpoint or attempt ledger.[1]

XState inspection events can feed diagnostics, traces, and the monitor. They are observational events, not authoritative durable business state; correctness must not depend on an inspector being attached or an inspection event being persisted.[2]

XState actors provide parent/child lifecycles. Invoked actors are tied to the invoking state; spawned actors are owned through actor context; stopping a parent or leaving an invoking state stops the corresponding children. Those mechanics are the right basis for supervision and cancellation propagation.[3] They do not prove that a Pi process, model request, gate command, or UI prompt has physically drained.

An XState actor ID and its system session ID are runtime identities. A caller may provide a custom actor ID, but neither identity supplies Panda's durable UUID semantics.[4] `NodeInstanceId` therefore remains a UUID v4 allocated and persisted by Panda. An XState actor ID may mirror that UUID for diagnostics only; it is never the source of durable identity.

## Audit findings

The baseline command `pnpm exec vitest run --project unit extensions/subagents/test/graph-*.test.ts` passed 333 tests. That is a useful behavior baseline, but missing regressions permit the defects below. Severity ranks recovery corruption and unsafe concurrent effects above observability and restriction gaps.

### Critical

1. **Active feedback can checkpoint an invalid restore state.** Restore validation requires every nonterminal feedback owner to be `running` (`graph-restore-validation.ts:64-71`). The driver validates the snapshot, hydrates the scheduler, and immediately checkpoints (`run-graph.ts:295-327`). Hydration changes ordinary `running` nodes to `pending` (`scheduler.ts:358-363`), but active feedback owners are changed back to `running` only later (`run-graph.ts:662-666`). A checkpoint in that interval can violate the validator's own active-ownership invariant.

2. **Stopping an actor can release a resource before execution drains.** The per-node completion promise resolves when the XState actor reports `stopped` (`run-graph.ts:421-441`). The drive loop then removes the inflight entry and releases resources before reading the result or handling retry (`run-graph.ts:854-865`). By contrast, host disposal explicitly aborts owned agents and awaits their promises (`node-host-adapter.ts:180-184`). Actor shutdown is therefore being treated as execution drain even though the host has a separate drain boundary. Another node can acquire the same exclusive resource while the stopped execution is still winding down.

### High

3. **Graph attempts and execution attempts are conflated, and restore can replenish retry work.** Every `markRunning` increments both `NodeRun.attempt` and the global run count (`scheduler.ts:201-207`). Agent setup maps internal retry callbacks back to `markRunning` (`run-graph.ts:402-406`), while hydration reconstructs the global count from that same attempt field (`scheduler.ts:358-377`). This conflicts with the shipped distinction that `NodeRun.attempt` counts graph-level starts while internal schema or gate retries remain within one graph attempt (`dynamic-agent-graph-expansion.md:86-90`). A restored promise invocation can also receive a fresh internal retry loop unless a separate execution-attempt ledger records what was already consumed.

4. **Skipped and cancelled feedback states can violate restore invariants.** A pending control skip directly settles a node as skipped (`run-graph.ts:693-695`), and quiescent resolution also skips pending nodes without starting them (`scheduler.ts:161-173`). Yet restore validation requires any non-pending bounded-feedback node to have feedback state (`graph-restore-validation.ts:64-65`). Cancellation synthesizes and settles feedback state separately (`bounded-feedback.ts:148-185`), while general scheduler validation accepts skipped nodes with zero attempts (`graph-state-validation.ts:11-18`). The paths do not share one transition protocol, so a skipped feedback owner can be persisted without the state required to restore it.

5. **Post-stop callbacks can mutate durable accounting.** The promise actor awaits `spawnAgent`, then invokes cost and failure callbacks after the await (`node-actor.ts:91-105`). Feedback failure callbacks mutate retry counters and checkpoint them (`bounded-feedback.ts:110-117`). Without correlation and stale-event rejection, a callback from an execution that was stopped, retried, restored, or superseded can update the current node instance.

6. **Human-gate cancellation is not a drain guarantee.** The host notes that `ctx.ui.select` has no signal and an open prompt settles only after the user responds or dismisses it (`node-host-adapter.ts:167-177`). The driver records only an aborting controller for the gate (`run-graph.ts:579`), while skip stops the inflight entry (`run-graph.ts:687-690`). Cancellation can therefore return before the UI interaction drains, matching the broader stop-versus-drain defect.

### Medium

7. **Literal fanout data can become an invalid restored prompt.** Fanout interpolation deliberately runs once so placeholder-looking text inside item data remains literal (`fanout.ts:44-55`). General graph validation, however, rejects every `${name}` not mapped by an agent node's `input` (`validate.ts:135-145,160-166`), and restored effective graphs pass through that validation (`graph-state-validation.ts:11-13`). A valid item containing literal placeholder syntax can produce a generated child definition that later fails restore validation.

8. **Indirect loops can reactivate work leading to a barrier.** Settlement reactivates a completed loop target by resetting it to `pending` and clearing its output (`scheduler.ts:250-263`). Validation rejects only a loop whose immediate target is `fanout` or `bounded_feedback` (`validate.ts:321-323`), and restored loop counters are checked without a transitive barrier rule (`graph-state-validation.ts:33-35`). A loop can therefore target an upstream node whose path reaches an already-materialized barrier, leaving unclear whether ownership and collected results should be reused, reset, or rematerialized.

9. **Recursive subgraphs have no explicit depth boundary.** A graph node resolves a child graph and recursively calls `runGraph` (`run-graph.ts:466-539`). Each child creates a fresh scheduler with only a local total-run ceiling (`scheduler.ts:80-87`). Recursive graph references can consume stack, actors, and independent budgets without a shared nesting limit.

### Low

10. **Retry telemetry does not identify an execution attempt.** Resolution data is merged by node ID (`graph-run-adapter.ts:189-197`), and monitor entries expose one node attempt plus the latest model and record fields (`graph-run-adapter.ts:243-273`). Late resolution from an old execution can overwrite current telemetry, and operators cannot correlate a record with one specific execution attempt.

These findings motivate the lifecycle work, but the Critical and High defects are correctness fixes, not optional benefits of adopting XState.

## Target actor hierarchy

The root `GraphActor` is the sole run-lifecycle authority:

```text
initializing
active
  running
  paused
cancelling
draining
checkpointingTerminal
terminal
```

`initializing` validates input and recovery facts before work can be admitted. `active.running` admits work; `active.paused` blocks new admission while admitted work continues. `cancelling` sends correlated cancellation. `draining` waits for every admitted execution and coordinator. `checkpointingTerminal` invokes final persistence, and only its successful completion selects and enters `terminal`.

Each materialized node has a typed `NodeActor`. Durable boundaries are represented as machine states with invoked Panda services, not as state changes published by an outside coordinator:

```text
pending
  → checkpointingAdmission (invoke persistAdmission)
  → admitted
  → executing
  → checkpointingSettlement (invoke persistSettlement)
  → terminal

executing
  → cancelRequested
  → checkpointingCancellation (invoke persistCancellation)
  → draining
  → checkpointingDrain (invoke persistDrainAcknowledgement)
  → checkpointingSettlement
```

Admission persists the instance, activation, graph attempt, and execution attempt before `admitted` can invoke external work. Settlement, cancellation, fanout materialization, and feedback decisions use equivalent checkpointing states and invoked persistence services. `draining` ends only on a correlated host acknowledgement; completion, failure, skip, and cancellation are machine outcomes, never scheduler mutations.

Dedicated coordinators express dynamic protocols as statecharts:

- `FanoutActor` owns collection preparation, checkpointed materialization, child supervision, and all-settled aggregation.
- `FeedbackActor` owns bounded iteration intent, materialization, evaluation, and checkpointed decisions.
- `ExpandActor` owns fragment validation and checkpointed atomic topology commitment.
- `SubgraphActor` supervises one child `GraphActor` and maps its terminal result to the parent node.

## Authority and planner boundary

XState state and runtime snapshots are authoritative for volatile, in-process lifecycle. The Panda checkpoint is authoritative for durable domain facts and permission to recover or dispatch. Panda must not mirror the whole state machine. XState inspection remains diagnostic only.

The scheduler becomes a pure planner, for example:

```ts
planReadyNodes(graph, committedDomainState): Admission[]
```

`GraphActor` decides when to call it and serializes the resulting lifecycle events. Panda computes readiness from committed facts but does not own node statuses. After migration, the scheduler has no lifecycle mutators such as `markRunning`, `settle`, `retry`, or `pause`.

## Event and attempt protocol

Every asynchronous result uses a correlated envelope:

```ts
interface GraphLifecycleEvent<T> {
  runId: string;
  instanceId: NodeInstanceId;
  activation: number;
  graphAttempt: number;
  executionAttemptId: string;
  payload: T;
}
```

The three counters have distinct meanings. **Activation** identifies one entry of a node into runnable lifecycle, including bounded loop reactivation. **Graph attempt** identifies an operator retry or graph-level restart of that activation. **Execution attempt** identifies one host invocation or repair attempt and has its own opaque ID. The actor accepts an event only when all correlation fields match its current admitted execution. Late cost, resolution, completion, failure, and drain events are rejected as stale and may be logged through inspection.

The append-only attempt/effect ledger records admission, dispatch, cancellation intent, drain acknowledgement, outcome, and authoritative cost for each execution attempt. This prevents restore from replenishing consumed retries and keeps graph attempts separate from schema repair.

## Checkpoint, restore, cancellation, and drain

Fresh admission is a machine protocol:

1. `GraphActor` invokes the pure planner, and Panda allocates or reuses the persisted `NodeInstanceId` UUID v4.
2. The node actor receives an admission event and enters `checkpointingAdmission`.
3. The state's `persistAdmission` service atomically commits the instance binding, activation, graph attempt, execution-attempt record, lease, coordinator intent, and effective topology.
4. Only service success transitions the actor to `admitted`, which may invoke the host adapter.
5. Correlated host results drive checkpointing states; successful persistence transitions then make dependent work eligible for planning.

Restore validates the complete Panda checkpoint, rebuilds the effective graph and actor inputs, reconciles admitted attempts and leases, and starts or recreates XState actors from those durable facts. Only ledger-permitted work may dispatch. Persisted XState snapshots may optionally help recreation, but they are non-authoritative: active invocations restart on restore, and XState does not supply exactly-once external effects.[1] Fresh replay creates a new `runId` and new instance UUIDs.

Cancellation follows one explicit rule: **actor stopped is not execution drained**. Leaving an invoking state or sending an abort requests cancellation, but resources and leases remain held until the host adapter returns a matching drain acknowledgement for `executionAttemptId`. A non-cooperative human gate may keep the graph in `draining`; shutdown policy may persist that fact, but must not report safe release prematurely.

Policy reauthorization is required before every restored or resumed external dispatch. A prior authorization record is durable evidence, not permission to repeat an effect under changed policy or capabilities.

## Dynamic mechanics

Dynamic operations use coordinator machine states and invoked Panda services, never callbacks that mutate shared lifecycle maps:

- **Fanout:** prepare and validate the complete collection; enter `checkpointingMaterialization` to commit ownership, definitions, UUIDs, and ordinals; then spawn children. This preserves checkpoint-before-dispatch.
- **Feedback:** move through checkpointed `intent`, `materialization`, supervised `work`, `evaluation`, and `checkpointingDecision`. A continuation returns to intent; termination records its reason and complete accumulation.
- **Expansion:** validate the placed fragment, enter a checkpointing state that atomically commits topology and identities, then expose the committed nodes to planning and monitoring.
- **Subgraph:** invoke a child `GraphActor` through `SubgraphActor` with a child checkpoint namespace; never recurse through an untracked drive loop.

Set an initial nested-graph depth limit of 32, validated before child creation and carried through restore. Until barrier reactivation semantics are specified and tested, reject loops whose target can transitively reach a `fanout` or `bounded_feedback` barrier. This is intentionally stricter than the current direct-target check and does not weaken the shipped barrier contracts.

## Delivery plan

### Required correctness fixes — Phase 0

Add focused regression tests for every audit finding. Make only urgent safety fixes in code scheduled for deletion: restore ordering, premature resource release, and other defects that can corrupt recovery or permit unsafe concurrent effects. Move lifecycle fixes into the new event protocol and machines wherever safe. Do not extensively repair the disposable driver, scheduler lifecycle, callback accounting, or promise supervision.

### Architectural migration

- **Phase 1 — domain event protocol and checkpoint attempt ledger.** Introduce correlated events, activation/attempt separation, stale-event rejection, leases, policy reauthorization, append-only validation, and drain acknowledgements without changing the public IR.
- **Phase 2 — root `GraphActor`.** Establish the single run-lifecycle authority around the pure planner and host adapters. At parity, delete the imperative drive loop, custom inflight actor map, manual completion race, and duplicate terminal selection.
- **Phase 3 — typed node and human-gate machines.** Add checkpointed admission, retry, cancellation, settlement, and drain states. At parity, delete scheduler lifecycle mutations, promise-only lifecycle ownership, callback attempt accounting, and stop-as-drain behavior.
- **Phase 4 — coordinator actors.** Migrate `FanoutActor`, `FeedbackActor`, `ExpandActor`, and `SubgraphActor` one at a time. After each coordinator reaches parity, delete its imperative fanout, feedback, expansion, or subgraph orchestration. Preserve checkpoint compatibility or provide an explicit versioned migration.

Each phase is independently reviewable and must preserve the shipped specifications. This is an incremental replacement, not XState wrapped around a parallel custom runtime.

### Success criteria

- One lifecycle authority: XState.
- One durable-facts authority: the Panda checkpoint.
- One external-effects owner: the host adapter.
- Zero parallel lifecycle maps.
- Zero manual actor supervision.
- Zero callback mutation of graph state.
- Checkpoint-before-dispatch, UUID v4 `NodeInstanceId`, policy reauthorization, append-only validation, fresh replay IDs, and resource release only after matching drain acknowledgement remain enforced.

### Optional later work — Phase 5

After the actor hierarchy and durable protocol are stable, consider persisted XState snapshots as a non-authoritative recovery aid, richer inspection traces, actor-system addressing, and more federated nested controls. These remain optional. They must not replace Panda checkpoints, expose machine definitions as `AgentGraph`, redefine UUID identity, or claim exactly-once external effects.

## Sources

[1] XState, “Persistence” (https://stately.ai/docs/persistence)

[2] XState, “Inspection” (https://stately.ai/docs/inspection)

[3] XState, “Actors” (https://stately.ai/docs/actors)

[4] XState 5.33.2, `packages/core/src/createActor.ts` (https://raw.githubusercontent.com/statelyai/xstate/xstate%405.33.2/packages/core/src/createActor.ts)
