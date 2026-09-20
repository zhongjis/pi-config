# Agent-Graph Bounded Feedback

Status: shipped

Owner: `extensions/subagents` graph runtime

Related: [Awaited Dynamic Agent-Graph Expansion](dynamic-agent-graph-expansion.md) · [Reusable Agent-Graph Workflow Portfolio](agent-graph-reusable-workflows.md) · [Graph Run Monitor](graph-run-monitor.md)

## Problem Statement

The shipped `fanout` node creates and awaits one dynamic task collection. Before bounded feedback, `shared/context-gather` predeclared two fanout/evaluator rounds, so the monitor showed a dormant round 2 when round 1 was sufficient. Supporting another round required another authored copy.

Panda Harness needed feedback-driven repetition without model-authored topology. Runtime identity also had to survive retry and restore without replacing readable graph references. Gate-only direct-file persistence could not materialize successor iterations safely, so crash-consistent checkpointing was a release prerequisite.

## Solution

Bounded feedback is a version-2 graph capability that composes around the existing `fanout` contract. A bounded-feedback node repeatedly instantiates an author-defined work template—initially a `fanout`—and an evaluator template. The evaluator returns a typed decision:

- `sufficient`, with no next tasks; or
- `continue`, with unresolved gaps and one or more gap-linked next tasks.

Each accepted continuation appends a new immutable iteration. The runtime, not the evaluator, validates the decision, allocates runtime identities, binds the fixed templates, enforces topology and budgets, persists the transition, and records the stop reason. The evaluator may propose tasks only through the author-declared work template; it cannot add arbitrary nodes or edges.

The feature preserves `fanout` as the single-collection primitive. Existing version-1 graphs and their `FanoutResult.nodeId` meaning remain valid. Random UUIDs identify materialized runtime instances only; authored keys remain readable and deterministic for graph authoring and source review.

## User Stories

1. As a graph author, I want bounded feedback to wrap an existing fanout template, so I can request another evidence iteration without copying fixed rounds into the saved graph.
2. As a graph author, I want the evaluator limited to typed gaps and tasks accepted by the work template, so model output cannot create unrestricted topology.
3. As a graph author, I want `NodeKey` to remain the stable reference in node maps, edges, `ValueRef`s, and source diffs, so graph files stay readable and deterministic.
4. As a runtime maintainer, I want every materialized node to receive an opaque UUID v4 `NodeInstanceId`, so runtime identity does not depend on labels, authored keys, list positions, or presentation order.
5. As an operator, I want duplicate or absent display names to be safe, so names can describe work without becoming hidden wiring.
6. As an operator, I want monitor rows to prefer the user-facing name and show iteration/item context, so repeated work is understandable without exposing internal identifiers.
7. As an operator, I want only materialized iterations to appear, so the monitor does not show dormant future rounds.
8. As an operator, I want failed and skipped child outcomes retained with successful evidence, so partial work remains inspectable and synthesis does not imply missing evidence succeeded.
9. As a workflow consumer, I want synthesis to receive every iteration result and unresolved gap, so the terminal output explains both the answer and its incompleteness.
10. As a graph author, I want explicit iteration, per-iteration item, total-item, node/run, deadline, and spend bounds, so feedback cannot grow without a hard limit.
11. As an operator, I want exact-repeat and no-result continuations to stop as no progress, so an evaluator cannot waste the remaining budget by repeating ineffective work.
12. As a runtime maintainer, I want malformed evaluator output retried within the same evaluator instance under policy, so schema repair is not misreported as another evidence iteration.
13. As a runtime maintainer, I want materialization recorded durably before dispatch, so restore neither changes instance IDs nor appends the same successor twice.
14. As an operator, I want retry and restore to retain instance IDs while recording new attempts, so one materialized node remains traceable across execution attempts.
15. As an operator, I want a fresh replay to create a new run and new instance IDs, so it cannot be mistaken for continuation of the original run.
16. As a graph author, I want version-1 graph files to remain valid, so adopting bounded feedback is opt-in through graph version 2.
17. As an operator restoring historical work, I want unsupported graph or snapshot versions rejected before execution, so incompatible state never runs partially.
18. As a maintainer, I want crashes around evaluator completion and successor materialization covered at the scheduler/persistence boundary, so the most dangerous transition has executable evidence.
19. As a downstream caller, I want every terminal result to include the stop reason and partial-completeness state, so sufficient, bounded, failed, and cancelled runs are distinguishable.

## Implementation Decisions

### Capability and ownership

- The graph schema and validator own version selection, template shape, typed evaluator decisions, `ValueRef` validation, and static budget validation.
- FeedbackActor owns volatile iteration sequencing through bounded committed owner views. FeedbackActor, every work FanoutActor, evaluator and item actor are direct root-owned siblings; the feedback coordinator never spawns or stops them.
- The evaluator proposes gaps and next tasks. Root transactions validate the decision, allocate identities, enforce template topology and all budgets, persist state, and choose the terminal reason.
- Root GraphActor owns planning, dispatch, attempts, controls, capacity, checkpoint and terminal authority. Coordinators consume no executor slots but block done/drain until release. The monitor adapter renders persisted runtime state; it does not infer identity or future topology.

### Identity and provenance

Identity has three separate concerns:

1. **`NodeKey`** is the stable, human-authored reference used by graph node maps, edges, `ValueRef`s, and source diffs. It remains readable and deterministic.
2. **`NodeInstanceId`** is an opaque canonical UUID v4 allocated from a secure random source for every materialized runtime node. It is persisted before dispatch, reused across retry and restore, and regenerated for a fresh run or replay.
3. **`name`** is an optional, non-unique user-facing label. It is never used for wiring, identity, ordering, or restore.

UUID uniqueness is validated within each run. Durable lookups are scoped by run ID plus instance ID; UUID lexical order never controls presentation. Every materialized node records the authored key, instance UUID, iteration ordinal, parent instance UUID where applicable, item index where applicable, and a run-local monotonic materialization ordinal.

Lifecycle rules are:

- each static node receives one runtime UUID for a fresh run;
- each bounded-feedback iteration receives fresh work and evaluator instances;
- each fanout child receives a fresh UUID;
- retry and restore retain the instance UUID and append attempt metadata;
- fresh replay creates a new run and new UUIDs, with optional lineage back to the prior run.

### Iterations, decisions, and accumulation

- Execution state and accumulation are append-only. Iteration ordinals start with the initial iteration and increase monotonically; accepted iterations and their topology bindings are immutable.
- `sufficient` must contain no next tasks. `continue` must contain at least one valid task, and every next task must link to a declared unresolved gap.
- A next task must satisfy the work template's item schema and dispatch constraints. Validation is all-or-nothing before successor materialization.
- Malformed evaluator output retries according to evaluator policy within the same evaluator instance and adds attempt metadata. It does not create a new iteration.
- The accumulator preserves every completed, failed, and skipped work result, every evaluator decision, and all unresolved gaps. Synthesis consumes the complete accumulation, not only the latest or successful results.

### Bounds and termination

- `maxIterations` is required and positive; it includes the initial iteration. `maxItemsPerIteration` and `maxTotalItems` are required positive bounds.
- Existing effective-node and node-run ceilings remain authoritative. Optional `deadline` is a positive safe-integer duration in milliseconds from the persisted v2 run start; optional `spendLimit` is positive finite USD. Unknown budget-shaped fields are rejected.
- The injected runtime clock defaults to `Date.now`. Check budgets before initial materialization, after evaluator completion before committing continuation intent, and on restored intent before allocating UUIDs, materializing or dispatching successors. Reaching a configured limit returns `deadline/spend limit`, `partial: true`, preserved accumulated evidence and `exhaustedBounds` naming `deadline` and/or `spendLimit`.
- Spend comes only from authoritative child `AgentRecord.lifetimeCost` → `NodeSpawnResult.costUsd` → persisted cumulative `NodeRun.costUsd`, summed across this region's work children and evaluator executions, including repairs. Never estimate from tokens. Missing accounting for any settled execution stops growth with `spend accounting unavailable` in `exhaustedBounds`.
- Bounds govern admission/continuation, not in-flight preemption: already-admitted work and evaluator repairs may finish beyond a limit. Omitting both limits preserves unbudgeted execution behavior.
- The runtime validates a proposed continuation against every bound before materialization. No evaluator decision can override a hard bound.
- An exact repeat of prior tasks or an iteration that produces no new usable result stops as `no progress`; hard bounds still apply and remain the authoritative ceilings.
- Terminal reasons are `sufficient`, `iteration limit`, `item limit`, `deadline/spend limit`, `no progress`, `evaluator failure`, `materialization failure`, `cancellation`, and `skipped before admission`. `skipped before admission` applies only to a scheduler skip that was never admitted, with zero attempts and no output.
- Exhausted child failures remain all-settled evidence. An exhausted evaluator failure stops growth but permits partial synthesis from valid accumulated state. Both preserve unresolved gaps and identify incompleteness in terminal output.
- Corrupt persisted state or failed materialization fails visibly as `materialization failure`; the runtime must not synthesize as though the state were complete.
- Cancellation preserves the last valid checkpoint and returns a cancelled partial result when that checkpoint is readable.

### Persistence, restore, and replay

- Before any new runtime node is dispatched, persistence writes a crash-consistent materialization manifest containing its UUID and topology binding.
- One atomic checkpoint covers UUIDs, topology bindings, immutable iteration records, counters, evaluator decisions, continuation intent, and materialization state. The decision and continuation intent are durable before successor materialization; the successor manifest is durable before dispatch.
- Restore resumes from the checkpointed transition. It must not mint replacement IDs for existing instances or append a duplicate successor iteration, including after crashes before or after intent, materialization, or dispatch.
- Root checkpoints the coordinator's running identity before actor creation. A running admission without feedback state is valid only before any descendants exist; initial intent is a separate committed transaction. Active restore attaches sibling work/evaluator actors using their existing IDs; terminal feedback owners create no actor.
- Iteration materialization is one atomic checkpoint containing work, evaluator, every item, collection ownership, graph definitions, UUIDs, provenance/ordinals and active feedback state. Work FanoutActor attaches to that collection without allocating again. Decision/history/continuation intent commit before any successor UUID allocation.
- Evaluator NODE repair/settlement commits failure evidence and accounting atomically. Feedback processes a terminal evaluator decision once from durable active state. Explicit whole-run cancellation commits coherent partial accumulation and leaf dispositions before cancellation signals and waits all sibling drains/releases; lifecycle shutdown retains nonterminal recovery state. Active feedback owner skip/retry is unsupported; ordinary generated leaf controls remain available.
- Retry may repeat an internal or external action; this contract does not promise exactly-once external effects. Attempt metadata makes repeated execution visible.
- Fresh replay creates a new run identity, start timestamp and zero accumulated execution spend, and rematerializes all runtime nodes with new UUIDs. Optional lineage may identify the source run but cannot reuse its instance IDs.
- Restore retains the durable start, cost totals and accounting gaps; suspension does not replenish budgets. Checkpoint validation rejects invalid budget metadata and replacement cannot rewrite the start, roll back budget-check time/costs, erase missing-accounting evidence or rewrite settled costs. Older unbudgeted v2 snapshots without a start remain usable; a deadline-configured snapshot missing its start fails closed rather than restarting its clock.

### Graph and snapshot versions

- An absent graph version means version 1. Existing version-1 graph files remain valid, and bounded feedback requires graph version 2.
- Version 1 retains the shipped `FanoutResult.nodeId` contract. It is not silently redefined as a UUID.
- Version 2 exposes `instanceId` plus stable authored-key and provenance fields for dynamic results. Presentation and wiring use their designated fields rather than overloading one identifier.
- Snapshot version 2 stores the instance manifest and bounded-feedback checkpoint state. Unknown graph or snapshot versions fail before execution.
- If version-1 snapshot upgrade is supported, it runs once and checkpoints the complete version-2 state before any dispatch. Otherwise restore fails with a clear unsupported-version error.

### Monitor and terminal output

- The monitor shows `name` first when present, otherwise a readable role or type label. Iteration and item context appears as metadata, for example `Research · iteration 2 · item 3`.
- Authored keys and UUIDs appear only in detail or debug views. UUIDs do not determine row order; the monotonic materialization ordinal does.
- Uninstantiated future iterations do not appear. A continuation becomes visible only from its persisted materialization manifest.
- The terminal output includes the stop reason, whether synthesis is partial, all accumulated outcomes, unresolved gaps, counters and exhausted bounds, and optional replay lineage.

## Testing Decisions

The highest testing seam is the scheduler/persistence boundary around evaluator completion and successor materialization. Tests drive typed evaluator results and injected persistence or dispatch failures through this boundary, then restore from captured checkpoints and assert externally visible topology, identities, attempts, monitor rows, and terminal output. Pure schema tests support this seam; private actor state is not an acceptance target.

Acceptance coverage must include:

1. **One-iteration sufficiency:** one work and evaluator instance materialize; `sufficient` creates no successor; synthesis receives the complete first iteration.
2. **One continuation:** `continue` materializes exactly one successor with fresh work, evaluator, and child UUIDs; synthesis receives both immutable iterations.
3. **Duplicate display names:** nodes with the same `name` retain distinct identities and correct wiring, ordering, restore, and detail views.
4. **Partial child failure:** completed, failed, and skipped children are accumulated; siblings continue; partial synthesis exposes unresolved gaps.
5. **Evaluator schema retry:** malformed output retries within the same evaluator UUID, appends attempt metadata, and creates no iteration until one valid decision is checkpointed.
6. **Repeated tasks/no progress:** exact repeated tasks and an iteration with no new usable result stop with `no progress` and do not materialize another successor.
7. **Iteration bound:** the initial iteration counts toward a positive `maxIterations`, and no iteration appears beyond it.
8. **Item bounds:** per-iteration and total-item limits reject continuation before materialization and return `item limit` with preserved evidence.
9. **Existing ceilings:** effective-node and node-run ceilings still stop growth before insertion or dispatch.
10. **Deadline and spend bounds:** injected-clock and authoritative-cost tests cover initial admission, evaluator completion before intent, restored intent before UUID allocation/dispatch, missing accounting, repair costs, immutable start/cost persistence, restore and fresh replay. Each configured limit stops growth with `deadline/spend limit`, named exhausted bounds and preserved partial evidence; malformed budget values and aliases fail validation.
11. **Cancellation:** cancellation before and during an iteration preserves the last valid checkpoint, adds no unintended successor, and returns the cancellation reason.
12. **Crash before intent:** restoring the prior checkpoint may reevaluate but cannot expose or dispatch an unrecorded successor.
13. **Crash after intent:** restore completes or resumes the one intended successor without duplicating the iteration.
14. **Crash after materialization:** restore reuses every manifest UUID and topology binding and dispatches only work not already settled.
15. **Crash after dispatch:** restore retains IDs and appends attempt metadata without claiming exactly-once external effects.
16. **Stable restore IDs:** static nodes, iteration templates, and fanout children keep their UUIDs across repeated restores.
17. **Fresh replay IDs:** replay creates a new run and new UUIDs while preserving authored keys and optional lineage.
18. **Version-1 compatibility:** unversioned and explicit version-1 graphs retain shipped fanout behavior and `FanoutResult.nodeId`; bounded feedback is rejected in version 1.
19. **Version handling:** unknown graph and snapshot versions fail before execution; any supported version-1 snapshot upgrade checkpoints once before dispatch.
20. **Monitor behavior:** only materialized iterations appear; rows use name-first labels, iteration/item metadata, materialization order, and detail-only authored keys/UUIDs.
21. **Failure policy:** exhausted evaluator failure yields partial synthesis, while corrupt state or materialization failure fails visibly and does not masquerade as complete synthesis.
22. **Downstream terminal output:** every terminal reason produces a typed result containing complete accumulated outcomes, unresolved gaps, counters, and partial-completeness state.
23. **Adjacent regression:** ordinary fanout still creates and awaits one collection with input-ordered all-settled results, and existing monitor behavior remains valid outside bounded feedback.

## Out of Scope

- Generic dynamic topology or unrestricted model-authored nodes and edges.
- Replacing authored graph keys with UUIDs, or using display names as identity.
- Changing the shipped version-1 fanout contract or redefining `FanoutResult.nodeId`.
- Unbounded evaluator loops or evaluator-selected templates, agents, edges, budgets, or stop policy.
- Exactly-once external side effects across retry or crash recovery.
- Subagent conversation continuation beyond existing runtime behavior.
- A mandatory migration of existing version-1 graph files or snapshots.

## Further Notes

- Bounded feedback generalizes repeated evidence gathering, not the whole graph topology. The initially supported work template is fanout; adding another template requires a separate versioned contract.
- `shared/context-gather` uses one bounded-feedback region with at most one gap-closing successor iteration while preserving its six-field `GatheredContext` output.
- Durable materialization uses validated append-only state, synchronized atomic replacement, and checkpoint ownership before dispatch.
