# 4. Graph actor context is an owned mutable aggregate

Status: shipped
Date: 2026-09-28
Related: [../../extensions/subagents/AGENTS.md](../../extensions/subagents/AGENTS.md) · [0002-remove-subagentworkflow-script-runtime.md](0002-remove-subagentworkflow-script-runtime.md)

## Context

The `agent_graph` runtime runs on an XState actor tree. XState's documentation says context is immutable: "The `context` object is immutable, so you cannot directly modify it," and "Do not mutate the `context` object. ... If you mutate the `context` object, you may get unexpected behavior, such as mutating the `context` of other actors." [1]

The runtime does not follow that guidance:

- The root machine's context (`extensions/subagents/src/graph/graph-actor.ts:386`) holds mutable queues (`admissions`, `inbox`, `outcomes`, `releases`, `cancels`, `replies`), `Map`s (`journals`, `coordinators`), a `children` function that reads `self.getSnapshot()`, and, after initialization, a `domain` object from `graph-domain.ts` that owns the scheduler projection.
- Actions mutate context in place. Across the seven machine files (`graph-actor.ts`, `node-lifecycle.ts`, `node-lifecycle-session.ts`, `fanout-actor.ts`, `feedback-actor.ts`, `subgraph-actor.ts`, `expand-actor.ts`), a regex count finds 108 lines with direct `context.*` assignments or mutating collection calls (`push`, `shift`, `splice`, `set`, `delete`, …). XState `assign(` appears once: `initialize` (`graph-actor.ts:143`), which itself mutates `context.domain` and returns the same references.
- Some eventless loops terminate only because an action mutates context. In `node-lifecycle.ts:101`, the `waiting` state's targetless `always` branch runs `askCancel`; it stops re-firing because `nodeRequest` sets `context.pending` (`node-lifecycle-session.ts:70`). In the root, `drainWaiting` (`graph-actor.ts:473`) runs `discardDrained`, which empties `outcomes` and `releases` (`graph-actor.ts:317-318`) and so falsifies its own guard.

Durability does not depend on XState state. `graph-actor.ts:123` reads "Root lifecycle authority. Panda checkpoints, not XState snapshots, remain durable." The extension contract says "Panda v2 remains authoritative; NEVER persist XState snapshots."

## Decision

Keep XState for the actor tree — spawn/stop, `sendTo`/`sendParent`, the parallel admission region, tags, and the node lifecycle chart — and treat each actor's context as an owned mutable aggregate:

1. **Never persisted.** Panda checkpoints are the durable truth; `getPersistedSnapshot` stays unused.
2. **Not a value.** A snapshot's `context` aliases later mutation; do not store, compare, or diff it as a point-in-time value.
3. **Read only by the owner.** Code outside the owning actor observes it through state matching and tags, not `.context`.

Rule 3 holds in production code today: outside the seven machine files, `src/` has no `getSnapshot()` call and no snapshot `.context` read. Tests are the exception: 14 reads of `getSnapshot().context` or `snapshot.context` across 7 files in `extensions/subagents/test/` (`graph-node-root`, `graph-node-machine-ack`, `graph-node-machine-drain`, `graph-subgraph-actor`, `graph-actor-nested`, `graph-coordinator-root`, `graph-typed-production`). They are accepted as white-box assertions; new production code must not add outside reads.

## Consequences

- The runtime inspection log (the `graphRuntimeTrace` setting, `<runId>.runtime.jsonl`) excludes context and event payloads; logged context would show later mutations, not the state at the logged event.
- `xstate/graph` model-based testing (`getShortestPaths`, `getSimplePaths`, `createTestModel`) cannot run on these machines as written, because traversal branches from shared snapshots. A machine must migrate to `assign` before it can use them.
- Mutation-terminated `always` loops are a known hazard: an action change that stops mutating the guarded field turns the loop infinite.

Rejected alternatives:

- **Rewrite every mutation to `assign` now.** Large churn across the ~9.7k-line `src/graph` runtime with strict protocol invariants, for little payoff while no feature needs value semantics.
- **Replace the root actor with a plain event-sourced reducer.** It would rebuild child supervision, message ordering, invoke cancellation, and delayed self-sends, and rework restore validation. Judged large and high-risk for a personal harness.

Revisit when any of these occurs:

- Replay or time travel from an event log is needed.
- A feature change requires editing three or more of the root's duplicated priority `always` lists.
- A bug is traced to an impure guard or a mutation-terminated loop.

Sources:

[1] XState docs — Context (https://stately.ai/docs/context)
