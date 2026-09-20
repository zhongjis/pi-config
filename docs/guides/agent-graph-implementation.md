# Agent Graph Runtime — Lifecycle Implementation

## Status

The typed `agent_graph` runtime lives in `extensions/subagents/src/graph/`.
The execution ledger and recovery protocol remain Panda-owned; XState v5 owns
the root run lifecycle. This guide records implementation boundaries, not
permission to execute graphs. The runtime contract is in
[`extensions/subagents/AGENTS.md`](../../extensions/subagents/AGENTS.md).

## Phase 0/1 — execution and recovery protocol

- Panda v2 checkpoints retain authored definitions, materialization UUIDs,
  ordinals, feedback ownership, nested invocation history, and execution ledger.
- Ledger events correlate run, instance, activation, graph attempt, and execution
  attempt. Repairs consume the same execution budget without minting graph starts.
- Validate original restored state before migration; reconstruct ownership,
  reconcile current and nested effects with dead-writer proof, apply matching
  drained dispositions, and commit coherent replacement before publication.
- Validation-gate recovery fails closed. Live delegation and gate capabilities
  remain dispatch-time checks, never permissions granted by a checkpoint.

## Phase 2 — root GraphActor

- `graph-actor.ts` exports `graphLogic` and `GraphActor` as the sole run-lifecycle
  authority. States cover initialization, running/paused admission, persistence,
  settlement, cancellation, physical drain, terminal checkpoint, and final error.
- `run-graph.ts` only creates/starts the actor, bridges AbortSignal to events,
  awaits `toPromise`, and cleans up the listener/actor.
- `graph-domain.ts` holds Panda domain transactions. Only root-machine actions
  select projection transitions. Capacity combines running projection rows with
  native live child identities and execution admission evidence, never a second status map.
- A capacity-limited admission wave commits before child creation. The first
  outcome schedules exactly one delayed self-FLUSH per generation; a bounded
  settlement batch commits outcome/cost/drain and projection changes before child
  removal or replacement admission.
- Typed agent/human machines own single-effect invokes. CANCEL carries the exact
  committed durable disposition, ACK precedes abort, and physical settlement remains
  mandatory. Pending gate/repair requests receive ACK without a follow-up effect.
  Native child ownership survives settlement ACK until explicit release completion.
- Pause affects admission only. Skip/retry controls use unique tokens,
  pre-send reentrancy rejection, and snapshot acknowledgments. Accepted requests
  serialize with persistence; rejected requests enqueue no mutation. Publications
  run outside actions from stable, post-commit queues.
- The first infrastructure/checkpoint error prevents subsequent writes and
  dispatch, cancels children, waits for physical drain, and is rethrown unchanged
  through `toPromise`. Cancellation during initialization cannot bypass recovery.
- Nested graphs are actual `graphLogic` children of root-owned SubgraphActor, never recursive `runGraph`
  calls. Invocation identity and monotonic checkpoint sequences bind typed
  request/ack transactions. The parent validates replacement, records namespace,
  history, and ordinals, and forwards the containing checkpoint upward.
  Acknowledgments cascade only after top-level synchronous commit. Duplicate
  current sequences are idempotent; conflicting/reordered requests fail closed.
  Buffered nested publications follow acknowledgment, not speculative mutation.
- Root depth is zero; depth above 32 is rejected before child creation and
  recursively at restore. Panda checkpoints remain authoritative; XState
  snapshots are not persisted.

Removed: the imperative root drive loop, `Inflight`/tracking/prepared/completion/
finish registries, manual completion/checkpoint/pause races, recursive `runGraph`,
`node-supervision.ts`, manual child subscriptions, and adapter terminal selection.

## Phase 3 packet 1 — pure planner and durable projection

- `Scheduler` and its lifecycle mutators are removed. `scheduler.ts` retains the
  unchanged persisted types; `graph-domain.ts` owns one `SchedulerState` projection.
- Pure `graph-planner.ts` functions propose readiness, skips, transitions, loop
  reactivation, collection aggregation, capacity/run limits, status, and outputs.
  Root transactions select proposals; `graph-projection.ts` applies them mechanically.
  The read-through `GraphProjection` facade retains only transient insertion-order
  indexes for dynamic numeric bindings, never a duplicate node/status map.
- Restore parsing preserves saved lifecycle evidence. Interrupted-work and drained
  disposition proposals are selected explicitly before replacement checkpoints.
- Feedback domain proposals retain decision, budget, and evaluator failure evidence.
  Subgraph/expand/fanout/feedback actors use root-selected COORD transactions. Agent/human lifecycle selection stays in root transactions.

## Phase 3 packet 2 — production typed node ownership

- `node-protocol.ts` defines immutable admission receipts and resolver-free NODE
  requests, ACKs, resolution, drain, handoff, and release messages.
- Its per-incarnation `NodeRequestJournal` captures requests by value, rejects
  conflicts/gaps/stale identities, and distinguishes prepared ACKs from committed
  replay. An acknowledged repair can replay against its old correlation without
  repeating a transaction or checkpoint.
- Root prepares ACKs inside transactions and commits them only after the containing
  checkpoint ACK cascade. Production agent/human admissions dispatch typed machines
  with explicit NODE.ADMITTED handoff; WORK and the whole-node callback bridge are removed.
- Atomic repair commits prior cost/outcome/drain and evaluator evidence together with
  the next admission. Restoring that checkpoint consumes the successor admission too;
  recovery requires dead-writer proof and physical reconciliation, never budget replenishment.
- Settlement ACK precedes RELEASE_READY → RELEASE → RELEASED. Until completion, native
  child ownership retains capacity, prevents same-ID replacement, and blocks graph done.
  Failure drains validate incarnation even when the child retains a pre-repair correlation.
- A cancellation committed while a normal settlement is in flight takes precedence
  over that proposal; an already-settled execution only completes its release handshake.

## Phase 4 Wave 1 — ExpandActor and coordinator protocol

- `coordinator-protocol.ts` defines immutable run/binding/instance/activation/attempt/
  incarnation receipts and resolver-free COORD requests, full-operation ACKs,
  admission handoff, release, cancellation, and infrastructure-drained messages.
  Per-incarnation root journals coalesce pending duplicates and replay committed
  ACKs without mutation or checkpoint; conflicts, reordering, and stale identities
  fail closed. Prepared ACKs are not replayable until outer/nested commit.
- `expand-actor.ts` sequences committed admission → source/namespace preparation →
  insertion or expected-failure request → ACK → release-ready/release/released.
  It has no host effects, planner, projection, or checkpoint capability.
- Root commits running admission before spawn. Restored interrupted expands retain
  their Panda attempt/identity and recompute resolved source; settled expansions
  do not spawn actors. Expand coordinators use no executor/resource capacity, but native
  ownership prevents same-binding admission and graph completion until release.
- The root revalidates insertion against current effective IDs and the 500-node
  ceiling, then atomically commits definitions, edges, manifest identities, and
  expand `{}` settlement. Only post-commit publications register dynamic nodes,
  before updates and admission. Fragment outputs retain their existing behavior.
- Missing/nonobject/malformed sources fail the expand node with existing errors.
  Whole-run cancellation commits before COORD.CANCEL and prevents pending insertion;
  lifecycle cancellation leaves running recovery evidence. Active expand skip/retry
  is unsupported. Infrastructure failure drains without writes or publications.
- Imperative `expandNode` orchestration is removed; `graph-fragment.ts` remains pure.
  Panda v2 checkpoints and normal agent/human/subgraph paths are unchanged.

## Phase 4 Wave 2 — FanoutActor

- `fanout-actor.ts` supervises collection sequencing through bounded committed owner
  views, not shared projections or native leaf ownership. Root owns coordinator and
  generated agent/human actors as siblings and remains capacity/control authority.
- Committed running admission precedes coordinator spawn. The materialization request
  resolves and validates the complete batch through `prepareFanout`, checks current
  collisions and limits, and commits definitions, UUIDs, ordinals, provenance and
  collection ownership before registration, updates or leaf admission.
- Restored collections attach without regenerating items, prompts or UUIDs; interrupted
  unmaterialized owners recompute without incrementing their attempt. Settled owners
  create no actor. An empty collection follows the same ordered aggregation protocol.
- Committed terminal child facts trigger an aggregation request; root revalidates rows
  with the pure ordered collection proposal and checkpoints owner settlement before
  ACK/release. Terminal leaf facts follow host drain; root retains native leaves through
  their independent NODE release even if their collection has already settled.
- Pause blocks leaf admission, not active aggregation/checkpoint/drain. Ordinary owner
  direct skip/retry remains unsupported; generated leaf controls remain available.
  Cancellation persists before coordinator signaling and waits for every sibling.
  Expected preparation errors fail the owner; infrastructure failures drain the root.
- `launchFanout` and automatic collection settlement are removed. Ordinary and feedback
  work collections use the same COORD journals/outer-commit ACKs and Panda checkpoints.

## Phase 4 Wave 3 — FeedbackActor

- `feedback-actor.ts` sequences initial intent → atomic iteration materialization →
  work settlement → evaluator settlement → decision/continuation intent → release or
  successor materialization. Bounded committed owner views contain no domain references.
  Each next transaction requires its preceding ACK and progressed committed owner facts.
- FeedbackActor, every work FanoutActor, evaluator and item are direct root siblings.
  Coordinators consume no executor slots; native ownership still blocks done/drain.
  Root remains planner, capacity, checkpoint, control and terminal authority.
- Running coordinator admission commits before spawn, including the recoverable window
  before initial intent. Restore reuses identities/attempts; settled owners spawn nothing.
  One materialization checkpoint contains every definition, UUID, provenance/ordinal,
  collection ownership and active feedback state; FanoutActor attaches without allocation.
- Decision/history/continuation intent commit before successor UUID allocation. Bounds
  are rechecked before growth; evaluator NODE repair preserves failure/accounting evidence
  within its own iteration. Durable active state makes terminal decisions exactly once.
- Whole-run cancellation atomically commits feedback accumulation and leaf dispositions
  before signaling, suppresses successor growth, and waits independent drains/releases.
  Lifecycle interruption remains resumable; active owner skip/retry stays unsupported.
  Generated evaluator/item controls retain their normal NODE behavior.
- Removed `BoundedFeedback`, its host/transaction lifecycle and mutable handled registry,
  `feedback.tick`, root `advance`, and automatic feedback collection compatibility.
  Pure durable types, schema/decision, continuation, budget and terminal proposals remain.

## Phase 4 Wave 4 — SubgraphActor

- Root owns SubgraphActor; the wrapper explicitly spawns and retains exactly one
  native `graphLogic` child. It adds no depth and never treats invoke exit as drain.
  Running parent receipt admission commits before wrapper handoff or child creation.
- Nested checkpoint frames relay through typed COORD operations into the existing
  root `acceptNested` transaction. Checkpoint data is immutable; callback identity
  stays intact, and publication remains the existing buffered root mechanism.
  Correlated ordinal-bearing ACKs cascade only after the outermost commit.
- Cancellation forwards even while an ACK is outstanding. Nested checkpoint and
  settlement requests continue during cancellation/drain. Parent skip/retry intent
  commits before signaling; physical child GRAPH.DRAINED becomes a correlated
  settlement request, followed by committed ACK and explicit release handshake.
  Native wrapper ownership retains parent capacity and excludes same-ID admission
  through physical drain, settlement and release.
- Root direct graph spawn, checkpoint inbox and graph-drained lifecycle are removed.
  Pure replacement validation, recursive recovery, disposition, history, ordinals,
  attempts, depth 32 and authorization remain unchanged; Panda v2 is authoritative.

## Phase 5 assessment

The optional deepening candidates are intentionally deferred:

- Persisted XState snapshots remain prohibited. Panda v2 already carries the durable
  topology, identities, nested checkpoints, feedback state, and execution ledger
  needed to rebuild a fresh actor hierarchy.
- XState inspection remains test-only. Production reporting already publishes committed
  node registration, updates, resolution metadata, and coordinator outcomes; no missing
  operational trace currently justifies a persistent trace buffer.
- Actor-system IDs remain volatile diagnostics, not durable identities or routing
  authority. Typed parent/child protocols cover current communication needs.
- Nested controls remain bounded at the whole-subgraph skip/retry boundary. Leaf-level
  control federation needs a separately specified, checkpointed target and ACK protocol.

Reassess only for a concrete recovery gap, an incident that existing committed telemetry
cannot diagnose, a real cross-tree lookup consumer, or an explicit nested-control
requirement. These triggers authorize design review, not implementation; Panda remains
the durable authority and no mechanism may claim exactly-once external effects.

## Remaining boundaries

- Existing execution does not provide filesystem isolation, rollback, or
  exactly-once external effects. Runtime installation stays separate from tests.

## Verification

- Root/typed-node/nested actor tests cover ordering, stable controls, request/ack/release,
  latest repair identity, duplicate/stale events, and physical drain/error paths.
- Existing graph regressions cover recovery, cancellation dispositions, nested
  history/ordinals, authorization, disposal, and the 497-node ceiling
  (fewer than 135 checkpoints and 140 clones). Depth tests cover 32 and 33.
- Run graph tests and the complete subagents unit suite with `--maxWorkers=2`,
  root and subagents typechecks, exact-file Biome, the programming no-excuse
  checker over changed/untracked subagents TypeScript, LSP diagnostics, and
  scoped `git diff --check`.
- Live monitor QA requires a fresh Pi session and the installed interactive
  shell surface; unit protocol checks do not substitute for that UI check.
