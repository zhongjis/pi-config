# GraphEngine — Greenfield Architecture for Typed Agent Graphs

Status: idea

This is a non-binding design, not a description of shipped behavior or approval to migrate the runtime. The runtime code under `extensions/subagents/src/graph/` and the [subagents runtime contracts](../../extensions/subagents/AGENTS.md) remain authoritative.

## Boundary and authority

Expose a narrow `GraphEngine` module with four operations:

| Operation | Responsibility |
| --- | --- |
| `start` | Validate a graph, create a durable run, and start or attach its run controller. |
| `command` | Submit correlated pause, resume, cancel, or supported node controls; return a committed result or rejection. |
| `inspect` | Read the committed run projection, including topology, attempts, status, and outcomes. |
| `subscribe` | Stream post-commit projection changes; subscribers never drive execution. |

`AgentGraph` stays the authored graph representation. `RunStore` owns a transactional `RunRecord`: the current projection of effective nodes, dependencies, attempts, commands, ownership, budgets, and outcomes, plus append-only audit records committed in the same transaction. A planner derives readiness and domain transitions from committed facts. The store is authoritative for graph semantics, read models, and recovery; the XState machine is a volatile, run-local **control plane** for event serialization, admission, cancellation, and drain orchestration. No XState snapshot is required or treated as recovery authority. A fresh controller is rebuilt from validated durable records.

```text
Pi agent_graph tool ──> background GraphRunManager ──> GraphEngine
                                                  │  start / command
                              inspect / subscribe │
                                                  ▼
                                   RunActor (XState; one per live run)
                                     │                    │
                                     │ transactions       └─ AttemptActors
                                     ▼                       (active effects only)
                         RunStore: RunRecord + audit          │
                                     │                        ▼
                                     └──── committed facts   executor seam
                                            └── monitor      (Pi agents, validation, fakes)
```

`RunActor` alone orders in-process decisions for a live run, but its state is disposable. It has only physically active `AttemptActor` children. A materialized node does not get a standing actor merely for being pending, waiting, or settled. Each `AttemptActor` owns one external execution or other physical effect through an executor seam that supports Pi agent execution, validation, and deterministic fakes. Human approval normally resides as a durable waiting record; create a live actor only while a host interaction actually needs physical supervision and drain. An executor's abort signal requests cancellation, not proof that the effect has ended.

## Durable transition and recovery protocol

For every admission, atomically validate capacity, permissions, dependency state, and budget; claim the run for one writer; and commit the node activation, graph attempt, execution-attempt ID, and dispatch intent **before** invoking the executor. Only committed admissions may dispatch. Each result, cost, cancellation, or drain event carries the run, node instance, activation, graph attempt, and execution-attempt identity. A transaction accepts it only against the current committed attempt; stale or duplicate results cannot overwrite newer outcomes or release capacity. Audit entries record the accepted transition alongside its new projection.

```text
ready → [claim + commit admission/attempt] → dispatch
      → result or cancel intent → physical drain → [commit settlement + release]
                           crash ────────┐
                                          ▼
                         validate store, prove writer dead,
                         reconcile effect, then resume or retry
```

A recovering controller validates the stored record, obtains exclusive writer ownership with dead-writer proof, and reconciles every admitted effect with the host before deciding whether to continue, retry within the recorded budget, or fail closed. A committed intent may not have dispatched, and a dispatched effect may have completed before its result was committed: recovery is **at least once**, not exactly-once external execution. Dispatch-time authorization is checked again before any new effect. Cancellation and retry dispositions are committed before signalling an executor. Keep capacity, leases, and exclusive resources held until the matching effect physically drains and its drain/settlement is committed; actor termination alone never releases them. A failed store commit stops new dispatch and triggers drain without pretending that uncommitted results are durable.

## Dynamic graph operations and pause

Fanout validates the whole expansion and atomically materializes children as ordinary nodes with stable run-scoped identities, ownership, order, and dependencies before any child dispatch. Aggregate the committed child outcomes in input order. Subgraphs normally compile into namespaced nodes in the **same run**, sharing its scheduler, store, writer, and resource accounting rather than creating nested run actors. Record invocation boundaries and lineage in the domain projection for presentation and controls; require explicit validation of namespace collisions, limits, and permissions before insertion. Feedback iterations, if supported, would likewise commit their intent and materialization before dispatch rather than require resident coordinator actors.

Pause is **quiescent**: commit a pause request, stop new admission, allow active attempts to settle and physically drain, finish their resulting transactions, then commit `paused`. A non-cooperative effect can delay that state; the interface must show `pausing` until the drain is real. Resume rechecks dispatch authorization before admitting more work. Cancellation similarly retains owned resources through physical drain.

## Pi integration and scope

The `agent_graph` tool submits runs and controls through a background `GraphRunManager`; the manager owns controller lifetimes independent of the tool call. An `AgentManager` executor adapter starts and reconciles Pi agent work. The monitor reads `inspect` and `subscribe` projections, never XState internals. On Pi lifecycle restart, the manager scans eligible same-session records, validates and claims them, reconciles effects, and creates new `RunActor` instances. This is a proposed integration shape, not a claim about current entrypoints.

An MVP would cover validated static typed DAGs, agent/validation executors, durable human waiting gates, atomic fanout, same-run compiled subgraphs, correlated controls, transactional audit/projection, safe drain, and same-session recovery. Defer bounded feedback and dynamic fragment expansion, cross-run subgraph orchestration, richer nested controls, and inspection traces until their semantics have explicit store transitions and tests. Do not treat a greenfield MVP as feature parity with the shipped runtime.

## Difference from the shipped runtime

The shipped runtime uses a root `graphLogic` XState actor as the run-lifecycle authority over Panda's durable projection, with typed node and coordinator actors; see the [runtime contracts](../../extensions/subagents/AGENTS.md).

| Concern | Shipped runtime | Greenfield idea |
| --- | --- | --- |
| Lifecycle truth | Root XState run authority selects transitions over the durable Panda projection. | Transactional `RunRecord` carries node lifecycle truth; XState orders volatile run activity. |
| Actors and protocols | Typed node actors and coordinator actors use NODE/COORD request–ACK–release protocols. | One `RunActor` and actors only for active physical effects; most coordinator handshakes become store transactions. |
| Dynamic structure | Fanout children and feedback workers are root siblings; subgraphs are native nested `graphLogic` children owned by `SubgraphActor`. | Fanout and, by default, subgraphs become ordinary namespaced domain nodes under one root scheduler. |
| Reads and pause | Committed Panda state feeds reporting; pause blocks admission while active settlement, checkpoint, and drain proceed, without waiting for a distinct quiescent paused condition. | `GraphEngine.inspect` / `subscribe` read committed store projections; pause enters `paused` only after active attempts settle and drain. |

Both designs retain checkpoint-before-dispatch, stable attempt correlation, stale-event rejection, and physical drain before release. The redesign shifts more node lifecycle truth into transactional domain records and trades explicit actor/protocol isolation for fewer moving parts and simpler store-based recovery, at the cost of less XState-native hierarchy. It does not establish a migration decision or relax current safety contracts.

## Invariants and rejected designs

- **Invariants:** One admitted writer per run; validated, atomic domain transitions; checkpoint/claim before external dispatch; attempt-correlated results and budgets; no stale overwrite; dispatch-time authorization; physical drain before resource release or terminal completion; recovery from durable records without claims of exactly-once effects.
- **Reject persisted XState snapshots as the source of truth:** volatile actor state cannot replace the durable topology, ledger, and reconciliation evidence.
- **Reject an actor per node or coordinator by default:** pending, waiting, and completed records need no live supervisor; use actors only where a physical effect needs one.
- **Reject recursive independent runs for ordinary subgraphs:** compile namespaced nodes into one run by default to keep accounting and recovery in one transaction boundary.
- **Reject pause-as-admission-toggle:** `paused` means active work has settled and drained, not merely that new work is blocked.
- **Reject actor-stop-as-drain and exactly-once claims:** host reconciliation and recorded attempts remain necessary after aborts and crashes.
