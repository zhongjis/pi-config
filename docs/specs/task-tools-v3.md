# Task Tools v3

Status: proposed

## Problem Statement

Pi currently mixes durable task tracking with execution lifecycle:

- The task extension supports only `pending`, `in_progress`, and `completed`, plus destructive `deleted` updates.
- Subagent terminal events, including stop and partial-output paths, can drive task completion.
- Task metadata can carry execution ownership or runtime linkage.
- `TaskExecute`, `TaskOutput`, and `TaskStop` combine logical work tracking with execution control.
- Readiness is inferred from status, dependencies, and owner fields rather than explicit task, attempt, and blocker semantics.
- Blocking `TaskOutput` waits have caused hung orchestration paths.
- Mode prompts compensate for weak contracts by manually preserving evidence and recovery context.

These couplings create recurring failures:

- worker termination can be mistaken for task completion;
- retries create replacement tasks instead of new attempts on one logical task;
- dependency and blocker transitions are ambiguous;
- restart and compaction recovery require inference from incomplete runtime state;
- stale workers can mutate current work;
- accepted evidence is not durable domain data.

## Goals

Task Tools v3 must:

1. Provide one generic task contract for Houtu, Kuafu, and future mode agents.
2. Restrict task mutation tools to mode agents acting as coordinators.
3. Track durable logical work independently from executor runtime.
4. Preserve one task identity across retries and executor changes.
5. Require accepted evidence for completion.
6. Make readiness, blocking, cancellation impact, and valid next actions deterministic.
7. Support safe concurrent sessions through atomic transitions, idempotency, revisions, and claim fencing.
8. Remain non-blocking; task tools never wait for worker or human completion.
9. Preserve task-domain history independently from Pi session logs and compaction summaries.

## Non-Goals

Task Tools v3 is not:

- a subagent launcher, process manager, or output-streaming API;
- a general workflow engine with conditional branches and failure handlers;
- a replacement for Pi sessions, compaction, or runtime logs;
- a distributed multi-host scheduler;
- a UI redesign;
- a migration layer for legacy task records.

## Actors and Capability Boundary

The contract uses role names rather than mode names:

- **Author:** defines a task.
- **Coordinator:** a mode agent that creates, schedules, revises, reviews, cancels, or tombstones logical work.
- **Executor:** performs one attempt. The executor may be the coordinator or a worker/subagent.
- **Reviewer:** evaluates submitted evidence. A mode agent reviews directly; a human reviews through a linked decision event.
- **Human:** supplies requested input or approval through a registered interaction surface.

One actor may hold several roles.

Only mode agents receive task mutation tools, hold attempt claim tokens, and call `TaskReview`. Worker/subagents receive instructions and return output or evidence through execution surfaces. They never receive claim tokens or mutate logical task records. The coordinator remains the logical claimant when a worker executes the bound runtime.

When a human reviews work, the coordinator calls `TaskReview` with a durable human-decision ID. Task Tools validates that event against the task, attempt, evidence manifest, and decision before applying the transition. Audit records distinguish the acting coordinator from the human reviewer.

The task schema records actor, mode, and session identifiers for attribution. Task behavior must not branch on a specific mode such as Houtu or Kuafu.

Independent review is recommended in mode guidance for complicated work. The task schema does not classify task complexity or enforce a review policy.

## Ownership Boundary

### Task extension

The task extension owns:

- task definitions and stable identity;
- dependency DAG and derived readiness;
- explicit blockers and verification gates;
- immutable attempt history;
- evidence manifests and review records;
- cancellation and tombstone semantics;
- revisions, idempotency, transition validation, and domain audit events.

### Subagent extension

The subagent extension owns:

- launch, stream, output, heartbeat, steer, stop, and resume;
- runtime records and executor health;
- execution identifiers;
- runtime recovery.

### Binding registry

Execution code owns a separate durable binding registry. It associates a logical attempt with an opaque executor handle:

```text
(taskId, attemptId) -> (executorKind, executionId, runtimeMetadata)
```

Task records never store runtime IDs, heartbeat state, or execution output as workflow truth. A coordinator joins task and binding data during recovery.

## Logical Model

### Persisted task status

```text
TaskStatus = open | active | awaiting_acceptance | completed | cancelled
```

- `open`: the objective still needs work. Open does not imply runnable.
- `active`: exactly one live logical attempt claim exists.
- `awaiting_acceptance`: an attempt submitted evidence and awaits review.
- `completed`: a reviewer accepted evidence. This is terminal success.
- `cancelled`: a coordinator explicitly ended the objective without success. This is terminal non-success.

There is no task-level `failed` status. Failure belongs to an attempt. A failed attempt returns its task to `open`, where it remains actionable or derives as blocked.

Completed and cancelled tasks are immutable except for tombstone visibility and append-only audit annotations.

### Derived operational state

```text
OperationalState = ready | blocked | active | awaiting_acceptance | terminal
```

Operational state is a projection, not mutable task data:

- an `open` task with no unresolved blocking condition is `ready`;
- an `open` task with any unresolved blocking condition is `blocked`;
- `active` and `awaiting_acceptance` mirror persisted workflow status;
- `completed` and `cancelled` are `terminal`.

`TaskList` groups and filters by operational state, including `blocked`. Coordinators cannot set `blocked` directly.

`blocked` applies only to the readiness projection of an `open` task. Every task response also includes `hasUnresolvedBlockers`, regardless of persisted status. A blocker may arise while a task is active or awaiting acceptance; operational state remains `active` or `awaiting_acceptance`, but submission or acceptance is rejected until the blocker is resolved.

### Attempt state

```text
AttemptStatus = active | submitted | accepted | rejected | failed | abandoned
```

Each retry creates a new attempt under the same task ID. Attempt identity and append-only history are immutable; current attempt status advances through validated events until it becomes terminal.

- `active`: one coordinator claimant holds the attempt token.
- `submitted`: the coordinator submitted a result summary and evidence manifest.
- `accepted`: review accepted the submitted evidence; the task is completed.
- `rejected`: review rejected the submission; the task returns to `open`.
- `failed`: execution did not produce a reviewable submission; the task returns to `open`.
- `abandoned`: the claim was explicitly released or reclaimed after loss; the task returns to `open`.

An attempt is terminal after it reaches `accepted`, `rejected`, `failed`, or `abandoned`. Runtime completion, exit, timeout, stop, partial output, or missing binding never changes task status by itself.

### Review records

Each `TaskReview` creates an immutable review record containing:

- acting coordinator identity and session attribution;
- reviewer identity and authority source;
- decision: `accept` or `reject`;
- reviewed attempt and evidence-manifest ID;
- human-decision event ID when the reviewer is human;
- checks performed;
- reason;
- timestamp.

Acceptance transitions `awaiting_acceptance -> completed`. Rejection transitions `awaiting_acceptance -> open` and terminates the submitted attempt as `rejected`.

## Blocking Model

`blocked` is derived from two sources:

1. **Computed dependency facts** from the DAG.
2. **Durable explicit gates** that require a recorded resolution.

The initial blocker view supports:

```text
dependency_pending    # computed from an incomplete required predecessor
dependency_cancelled  # durable verification gate
human_input           # durable gate linked to a human-response event
manual_hold           # durable coordinator-created gate
retry_attention       # optional coordinator-created attention gate
```

`dependency_pending` is never stored as duplicate mutable state. The dependency edge remains the source of truth.

Each durable gate records:

- blocker ID and type;
- task ID;
- source task, event, or actor when applicable;
- machine-readable reason and human-readable summary;
- creation and resolution timestamps;
- creating and resolving authority;
- allowed resolution actions;
- linked evidence or response ID.

Task responses include unresolved blockers and `nextValidActions`.

The task tool records attempt counts and history but does not enforce retry budgets. Mode guidance decides whether to retry, revise, split, reassign, request input, add `retry_attention`, or cancel.

## Dependency Model

The first v3 contract supports a small edge vocabulary:

```text
requires_completion  # blocking; satisfied only by accepted completion
related              # informational
parent_child          # structural; no automatic completion semantics
```

Rules:

- `requires_completion` is satisfied only when the prerequisite is `completed`.
- `TaskAddDependency` and `TaskReplaceDependency` reject a `requires_completion` edge whose prerequisite is already `cancelled`; informational or structural edges remain available.
- `cancelled` never satisfies `requires_completion`.
- Informational and structural edges do not affect readiness.
- Adding an edge must reject cycles.
- The DAG has its own monotonically increasing `graphRevision`.
- Every graph mutation verifies `expectedGraphRevision` and returns newly ready tasks, newly blocked tasks, affected task revisions, and dependency paths.
- Dependency mutations execute atomically with gate changes, all affected task revisions, graph revision, and readiness recomputation.
- Conditional execution edges such as run-on-failure remain out of scope until a concrete Pi use case requires them.

Accepted predecessor context may be transferred to dependent executors only through compact accepted summaries and evidence references, never raw runtime logs.

## Cancellation Impact

`TaskPreviewCancel` is a non-mutating read. It returns:

- `previewId`;
- source task revision and graph revision used by the preview;
- unfinished direct dependents with their task revisions and proposed gates;
- all transitive affected task IDs and dependency paths;
- an `impactFingerprint` over the source state, direct-dependent states, graph revision, and consequence set;
- warnings and proposed `nextValidActions`.

`TaskCancel` requires the preview ID, matching revisions and impact fingerprint, and a reason. It recomputes the consequence set under the mutation lock and rejects any mismatch, including a direct dependent that changed state after preview.

When a prerequisite is cancelled, an **unfinished direct dependent** means a dependent whose status is `open`, `active`, or `awaiting_acceptance`:

1. The cancelled task becomes terminal.
2. Each unfinished direct dependent linked by `requires_completion` receives a `dependency_cancelled` verification gate and a new task revision.
3. Further descendants remain blocked through normal dependency propagation.
4. The mutation returns all transitive affected task IDs, per-task revisions, and dependency paths.
5. No dependent is silently completed or automatically cancelled.

For an `open` direct dependent, the coordinator must choose one audited action:

- cancel the dependent;
- revise it, then remove the cancelled dependency with a reason;
- atomically replace the cancelled dependency;
- waive the dependency by removing it with a reason.

An `active` dependent must first end its attempt as `abandoned` or be cancelled. An `awaiting_acceptance` dependent must first be rejected or cancelled. These transitions preserve attempt evidence and return non-cancelled work to `open` before graph edits.

A `dependency_cancelled` gate cannot be resolved directly. It clears only as an atomic consequence of `TaskCancel`, `TaskRemoveDependency`, or `TaskReplaceDependency`. Cancelling a dependent repeats the direct-gate and transitive-impact process for its descendants.

## Trusted Human Events

A coordinator creates a `human_input` gate before invoking the interactive ask surface or a persisted human-wait surface. Gate creation registers an expected interaction request ID, which the coordinator passes to that surface.

The registered human-interaction adapter emits a durable event containing:

```text
eventId
responseId
interactionRequestId
taskId
blockerId
humanActorId
payloadDigest
timestamp
```

Task Tools accepts human events only from the registered adapter. Its event handler serializes against task mutations, verifies all IDs against the unresolved gate, appends the source event and resolution event, and increments the task revision. Duplicate `eventId` or `responseId` values replay the original result; mismatched links or payloads are rejected and audited. Registering the expected request before interaction prevents response-before-gate races.

The coordinator cannot provide raw response text as proof of human action. A human review uses the same trust boundary: the adapter emits a structured `accept` or `reject` decision bound to the task, submitted attempt, and evidence-manifest ID; `TaskReview` must reference that decision ID.

Task tools remain non-blocking. Creating a human gate or requesting human review never waits for a response.

## Evidence Model

Each submitted attempt carries an immutable evidence manifest.

The manifest may contain:

- short inline evidence;
- result summaries;
- checks performed and their outcomes;
- durable artifact references with URI or path, media type, digest, and summary;
- source revision or commit identifiers;
- timestamps and producer attribution.

Large artifacts remain owned by their source system or an artifact-storage component. Task Tools does not become a blob store. Ephemeral subagent output alone is not acceptable evidence.

`TaskReview` pins the immutable evidence manifest submitted by the attempt. Additional evidence requires rejection followed by a new attempt and submission; accepted proof cannot change silently.

## Concurrency and Idempotency

Every public mutation supports:

```text
requestId              # durable idempotency key
expectedRevision       # rejects stale task writes
expectedGraphRevision  # required for graph-affecting writes
reason                 # required for cancellation, overrides, and visibility changes
```

Idempotency identity is `(callerAuthorityId, requestId)`, where `callerAuthorityId` comes from the harness authentication context and cannot be supplied in tool arguments. Task Tools stores the operation name, canonical payload digest, and original response. The same authority reusing the ID with the same operation and payload receives the original response even if current state advanced. A different payload or operation fails with `IDEMPOTENCY_CONFLICT`. A different authority cannot replay another authority's response or capability secrets.

Capability secrets receive stricter handling. Attempt records store only a claim-token hash. Raw tokens appear only in the claimant's `TaskStartAttempt` response and same-authority idempotent replay, protected as secret response fields. `TaskGet`, `TaskList`, `TaskHistory`, audit events, evidence, logs, and cross-authority errors never expose token material.

Trusted human and recovery events use separate durable event IDs, source-adapter identity, and payload-digest rules.

`TaskStartAttempt` atomically:

1. validates that the task is `open` and derived `ready`;
2. verifies `expectedRevision`;
3. creates one active attempt;
4. returns `attemptId`, an unguessable claim token, and the new revision.

The logical claimant is always a task-capable mode-agent coordinator. Only its current claim token can submit or end the attempt; a bound worker never receives the token. A real retry receives a new attempt ID and claim token.

There is no same-attempt token transfer. An explicit handoff uses `TaskEndAttempt(abandoned)` with optional `handoffToAuthorityId` and a handoff summary. This metadata is advisory: it appears in next-action guidance but does not reserve the task. The next `TaskStartAttempt` remains an atomic claim race and may be won by any authorized coordinator. The old coordinator never sees the winning claimant's token.

`TaskReclaimAttempt` requires a durable recovery-proof ID from the registered binding-registry adapter. That proof must identify the task and attempt and attest that no live execution remained after the harness-configured grace period. Reclaim abandons the old attempt, returns the task to `open`, and fences the old token; a new attempt must then be started.

Validation, mutation, event append, revision increment, and readiness recomputation occur in one serialized transaction or critical section. Validation-before-write without atomicity is invalid.

## Public Tool Contract

Prefer narrow transition tools over broad status mutation.

### Read tools

- `TaskGet`: returns one decision packet for a task.
- `TaskList`: groups or filters tasks by persisted status, operational state, blocker type, coordinator attribution, graph, or tombstone visibility.
- `TaskHistory`: returns task-domain events, attempts, reviews, blockers, and evidence manifests.
- `TaskPreviewCancel`: returns a revision-bound cancellation consequence preview.

A decision packet includes:

- task definition, task revision, and graph revision;
- persisted status and derived operational state;
- `hasUnresolvedBlockers` and unresolved blocker view;
- dependency summaries and accepted predecessor evidence references;
- active or latest attempt with all claim-token material redacted;
- `nextValidActions`;
- warnings and recovery hints.

### Definition and graph tools

- `TaskCreate`
- `TaskEditDefinition`
- `TaskAddDependency`
- `TaskRemoveDependency`
- `TaskReplaceDependency`

Definition and dependency edits require the dependent task to be `open`. Definition edits cannot mutate workflow status. Graph tools verify `expectedGraphRevision` and return direct and transitive consequences.

### Attempt and review tools

- `TaskStartAttempt`
- `TaskReclaimAttempt`
- `TaskSubmitAttempt`
- `TaskEndAttempt` with `failed` or `abandoned` outcome; abandoned attempts may include handoff target and summary
- `TaskReview` with `accept` or `reject` decision and optional validated human-decision ID

### Gate and terminal tools

- `TaskAddBlocker` for `human_input`, `manual_hold`, or `retry_attention`
- `TaskResolveBlocker` for `manual_hold` or `retry_attention`
- `TaskCancel` with a current cancellation preview
- `TaskDelete` for tombstoning only

`dependency_cancelled` gates are created by graph transitions, not arbitrary coordinator calls, and clear only through the associated cancel/remove/replace operation. `human_input` gates resolve only through trusted linked human-response events.

### Removed execution surface

Task Tools v3 does not expose:

- `TaskExecute`
- `TaskOutput`
- `TaskStop`

Execution stays in the subagent/runtime extension.

### `TaskUpdate`

V3 has no broad lifecycle setter. If retained as a temporary internal adapter during implementation, `TaskUpdate` may edit non-lifecycle definition fields only and is not part of the v3 mode-agent contract.

### Mutation response envelope

Every mutation returns:

```text
revision
graphRevision
persistedStatus
operationalState
hasUnresolvedBlockers
blockers
nextValidActions
newlyReadyTaskIds
newlyBlockedTaskIds
affectedTaskIds
affectedTaskRevisions
affectedPaths
createdBlockerIds
impactFingerprint
previewBasis
warnings
```

Fields that do not apply return empty values rather than disappearing unpredictably. Graph-affecting responses identify direct effects separately from transitive paths.

## Transition Rules

| Operation | Required state | Result |
|---|---|---|
| `TaskStartAttempt` | `open` + `ready` | task `active`; attempt `active` |
| `TaskReclaimAttempt` | task and attempt `active`; valid recovery proof | task `open`; attempt `abandoned`; old token fenced |
| `TaskSubmitAttempt` | task `active`; valid claim; no unresolved blocker | task `awaiting_acceptance`; attempt `submitted` |
| `TaskEndAttempt(failed)` | task `active`; valid claim | task `open`; attempt `failed` |
| `TaskEndAttempt(abandoned)` | task `active`; valid claim; optional handoff target | task `open`; attempt `abandoned`; old token fenced |
| `TaskReview(accept)` | `awaiting_acceptance`; no unresolved blocker; valid reviewer authority | task `completed`; attempt `accepted` |
| `TaskReview(reject)` | `awaiting_acceptance`; valid reviewer authority | task `open`; attempt `rejected` |
| `TaskCancel` | `open`, `active`, or `awaiting_acceptance`; current preview and impact fingerprint | task `cancelled`; any live attempt ends `abandoned` |
| `TaskDelete` | `completed`, `cancelled`, or structurally unused `open` task | task tombstoned; logical outcome unchanged |

Forbidden transitions include:

- direct mutation to `completed`, `cancelled`, or derived `blocked`;
- reopening `completed` or `cancelled`;
- submission or acceptance with unresolved blockers;
- accepting missing, mutable, or ephemeral-only evidence;
- using an unvalidated human decision or recovery proof;
- stale-token attempt mutation;
- graph mutation against a stale graph revision;
- deletion that would change dependency truth or hide unresolved graph consequences.

## Recovery

On startup or session replacement, a coordinator reconciles task attempts with the execution binding registry:

- **Active attempt, live binding:** continue observing through runtime tools.
- **Active attempt, missing binding:** surface a recovery warning. The binding registry may emit a recovery proof only after its configured grace period and a fresh no-live-execution check.
- **Stopped or lost runtime:** never complete the task; end the attempt as failed or abandoned through the logical API.
- **Completed runtime, no submission:** keep the task active until the coordinator submits durable evidence or ends the attempt.
- **Submitted attempt, lost runtime:** review remains possible because evidence is durable.
- **Late runtime response:** stale claim token prevents mutation.

Compaction summaries and Pi session JSONL are execution trace, not shared task-domain truth. Recovery reads the task store and binding registry.

## Audit and Persistence

Task-domain history is mandatory and append-only. Each event records:

- event ID and request ID;
- task, attempt, blocker, review, and evidence IDs as applicable;
- actor, mode, and session attribution;
- old and new revisions;
- operation, reason, and timestamp;
- structured consequences such as affected tasks and dependency paths.

Optional interaction traces may link to domain event IDs, but they never replace domain history.

Completed tasks remain durable and immutable. The system does not auto-clear accepted history.

### Tombstones

`TaskDelete` changes visibility; it does not invent a logical outcome or alter dependency truth.

A task may be tombstoned only when it is:

- `completed`;
- `cancelled`; or
- `open` with no attempts, blockers, evidence, reviews, or dependency edges.

Additional rules:

- Tombstoning requires a reason and returns its visibility consequences.
- `TaskList` excludes tombstones by default and supports `includeTombstoned`.
- `TaskGet` by ID, `TaskHistory`, graph traversal, readiness, cancellation impact, and accepted predecessor context continue to include tombstoned records where semantically required.
- Tombstones preserve identity, edges, attempts, evidence, reviews, and audit history.
- Normal agent tools cannot hard-delete records.
- Administrative storage cleanup, if ever added, remains outside Task Tools.

## Storage and Rollout

Task Tools v3 uses a new schema and store namespace. It provides no legacy compatibility or in-place migration.

Rollout must:

1. leave any legacy store separate and read-only or explicitly discard it through an operator-controlled action;
2. never reinterpret legacy `deleted` records as cancellation;
3. never fabricate accepted evidence for legacy completion;
4. start all v3 graphs under the v3 contract.

Compatibility shims must not be visible to mode agents or weaken v3 invariants.

## User Stories

1. As a mode-agent coordinator, I can use the same task contract regardless of active mode.
2. As a coordinator, I can select deterministic ready work without reading runtime metadata.
3. As a coordinator, I can retry one logical task through distinct attempts with immutable identity and history.
4. As a coordinator, I receive a claim token that fences late executor responses.
5. As a coordinator, I can submit evidence without marking work complete.
6. As a reviewer, I can accept or reject the exact submitted evidence manifest.
7. As a coordinator, I see why a task is blocked and which actions may resolve it.
8. As a coordinator, I see direct and transitive cancellation impact before and after cancellation.
9. As a coordinator, I can revise, replace, waive, or cancel work affected by a cancelled prerequisite.
10. As a human, my response resolves a human gate through a directly attributed event.
11. As an operator, I can recover active attempts after session replacement without trusting compaction text.
12. As a maintainer, I can test every lifecycle transition through a narrow public contract.
13. As an auditor, I can trace completion to accepted evidence rather than executor exit.
14. As a worker, I receive compact accepted predecessor context without gaining task mutation authority.

## Implementation Decisions

1. Keep task and runtime stores separate.
2. Build one mode-neutral contract and expose mutation tools only to mode agents.
3. Persist only `open`, `active`, `awaiting_acceptance`, `completed`, and `cancelled`.
4. Derive `blocked` from dependency facts and durable gates.
5. Model execution failure only on attempts with immutable identity and append-only history.
6. Require explicit evidence submission and review for completion.
7. Use direct cancellation-verification gates plus transitive impact reporting.
8. Keep retry policy in mode guidance; Task Tools records history but enforces no budget.
9. Use attempt-level exclusive claims plus revision-based graph concurrency.
10. Resolve human gates through linked response events.
11. Store hybrid evidence manifests; do not store large blobs.
12. Tombstone normal deletion and expose no hard delete.
13. Use a clean v3 store with no legacy migration.
14. Keep every task API non-blocking.

## Testing Decisions

### Public contract tests

Test only public transitions and reads:

- create, edit, and dependency graph operations;
- start, submit, fail, abandon, accept, and reject;
- cancellation, blocker resolution, and tombstoning;
- decision-packet and history projections.

### State and invariant tests

- no task-level failed state exists;
- an open task's `ready`/`blocked` projection always matches dependency and gate truth;
- `hasUnresolvedBlockers` is correct for every persisted status;
- accepted evidence is required for completion;
- cancelled prerequisites never satisfy dependencies;
- completed and cancelled tasks cannot reopen;
- runtime events cannot mutate logical completion;
- accepted history remains immutable.

### Graph tests

- cycle rejection;
- graph revision conflicts;
- add, replace, remove, and re-add behavior when the prerequisite is cancelled;
- cancellation preview rejection after source, direct-dependent, graph, or consequence-set changes;
- only direct dependents receive `dependency_cancelled` gates;
- cancellation-created gates increment every affected direct dependent's task revision;
- all transitive impact IDs, per-task revisions, and paths are returned;
- active dependents must abandon or cancel before remediation;
- submitted dependents must reject or cancel before remediation;
- graph/gate resolution is atomic;
- newly ready and newly blocked sets are correct.

### Concurrency and authority tests

- matching request replay by the same authenticated authority returns the original response;
- replay by another authority cannot reveal claim tokens or prior response data;
- read, history, audit, evidence, log, and error surfaces never expose raw claim tokens;
- duplicate request IDs with different operations or payloads fail;
- stale task or graph revisions fail without partial writes;
- workers cannot receive or use claim tokens;
- stale claim tokens cannot submit or end work;
- concurrent starts create exactly one active attempt;
- advisory handoff abandons the old attempt and fences its token without reserving the next claim;
- reclaim requires valid binding-registry proof and fences the old token;
- validation and persistence have no time-of-check/time-of-use gap.

### Evidence and review tests

- ephemeral-only evidence is rejected;
- accepted review pins one evidence-manifest ID;
- rejection returns the same task to `open` with a terminal rejected attempt;
- direct mode-agent self-review is allowed by contract;
- human review requires a matching trusted decision event;
- acting coordinator and human reviewer attribution remain distinct;
- mode guidance recommends independent review for complicated work.

### Human-event tests

- coordinator can create but cannot self-resolve `human_input`;
- forged source, wrong blocker, mismatched task, or conflicting payload is rejected;
- duplicate events are idempotent;
- expected interaction registration prevents response-before-gate races;
- only the trusted linked human-response event resolves the gate;
- tool calls remain non-blocking before and after pause/resume.

### Recovery tests

- active attempt with live, missing, stopped, or stale binding;
- invalid, premature, mismatched, and duplicate recovery proofs;
- cancelling an active task abandons its attempt and fences its token;
- cancelling an awaiting-acceptance task preserves submitted evidence and review history;
- completed runtime with missing submission;
- submitted evidence after runtime loss;
- late executor response after reclaim;
- session replacement and compaction recovery.

### Tombstone and rollout tests

- tombstoning does not change dependency truth;
- default lists hide tombstones while direct reads and required graph traversal retain them;
- only structurally unused open tasks or terminal tasks can be tombstoned;
- the v3 namespace never reads, migrates, or reinterprets legacy records.

### Capability tests

- Houtu and Kuafu receive the same generic task contract;
- worker/subagents do not receive task mutation tools;
- no mode prompt uses `TaskExecute`, `TaskOutput`, or `TaskStop`.

### Evaluation targets

- false logical completion rate: zero;
- blocked tasks never auto-complete;
- cancelled prerequisites never unlock normal dependents;
- stale executor mutations: zero;
- no task API performs an unbounded wait;
- every terminal success traces to accepted durable evidence.

## Prior Art: Reuse, Adapt, Reject

Task Tools v3 draws selected patterns from `marcus/td` and `gastownhall/beads` without adopting either data model wholesale.

### Reuse

- typed blocking versus informational dependencies, cycle checks, graph inspection, and structured machine-readable responses from Beads;
- explicit implementation/review transitions, rejection reasons, and structured handoff history from `td`;
- consequence previews, audited overrides, and durable domain history.

### Adapt

- Beads escalates failed or cancelled external gates rather than resolving them. V3 adapts this into `dependency_cancelled` verification gates.
- `td` supports explicit review and rejection. V3 keeps explicit review but leaves independent-review requirements in mode guidance.
- Both preserve substantial history without a generic immutable attempt entity. V3 adds first-class attempts.

### Reject

- "closed means dependency satisfied"; only accepted completion satisfies a v3 required dependency;
- automatic downward close, cancel, or delete cascades;
- status-only blockers;
- retries that overwrite prior attempt identity;
- force overrides without reason, impact reporting, and audit.

References:

- [`td` lifecycle and review semantics](https://github.com/marcus/td/blob/0f39dfebff89079b9fdb5d3bfd46944008ef07f2/docs/implemented/SPEC.md#L18-L44)
- [`td` transitive dependency inspection](https://github.com/marcus/td/blob/0f39dfebff89079b9fdb5d3bfd46944008ef07f2/cmd/dependencies.go#L16-L132)
- [Beads dependency semantics](https://github.com/gastownhall/beads/blob/64a136d56e8ae2b89071e57f90f57255e56c9ad9/docs/DEPENDENCIES.md#L7-L77)
- [Beads gate escalation](https://github.com/gastownhall/beads/blob/64a136d56e8ae2b89071e57f90f57255e56c9ad9/docs/CLI_REFERENCE.md#L664-L700)
- [Beads deletion safeguards](https://github.com/gastownhall/beads/blob/64a136d56e8ae2b89071e57f90f57255e56c9ad9/cmd/bd/delete.go#L241-L360)
