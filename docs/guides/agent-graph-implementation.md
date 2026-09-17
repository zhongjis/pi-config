# Agent Graph Runtime — Section 1 Implementation Plan

Draft implementation plan for the runtime described in
[`../ideas/agent-graph-design-v2.md`](../ideas/agent-graph-design-v2.md) (Status: idea, non-binding).
This plan covers **Section 1 only** — the `agent_graph` runtime and tool inside
`extensions/subagents`. Section 2 (reusable workflow portfolio, mode integration) is
deferred and out of scope here.

## Status — shipped

Section 1 is implemented and green on `main` (unit suite passes except pre-existing
Herdr-pane WIP + a macOS `/tmp` gate test). Delivered: `xstate` dep + `src/graph/`
module; IR + validator; XState node actor with schema/gate/bounded-retry lifecycle;
pure scheduler (readiness, conditions, bounded loops, skips, resources); async
`run-graph` driver with global + per-resource concurrency and live controls
(pause/resume/skip/retry); all four node types — **agent, subgraph, expand,
human_gate**; real `AgentManager` `NodeHost` adapter; the `agent_graph` tool
(saved `.graph.json` + inline, validated, opt-in, background task + notify);
the `/agents → Workflows` monitor showing graph runs grouped by topological stage
with per-node status, dependency hints, and controls; **durable human_gate
persistence** across a restart (persist at gate → reload on `session_start` →
re-surface, proven end-to-end); and the `agent-graphs` authoring skill.

Deferred / out of scope: legacy script-runtime removal (§2.8, gated on the deferred
Fuxi/Houtu migration) and the Section 2 reusable-workflow portfolio.

## Locked decisions

- **Replace** the `SubagentWorkflow` script runtime with a typed, graph-first runtime on **XState v5**.
- **Pure-data graph IR.** No user-authored JavaScript executes. No `node:worker_threads` Worker, no `terminate()` kill switch; XState actors run in the host process.
- **No `action` node.** Deterministic host checks are node **validation policy** (a gate command bound to a node's completion, authorized separately) — the only place a host command runs.
- **Modes out of scope.** Fu Xi / Hou Tu / Kua Fu stay Mode Agents; not migrated here.
- **Two existing scripts discarded.** `workflows/deep-research.js` and `workflows/last30days.js` are out of scope — discard/deprecate, no port.

## XState v5 grounding (verified)

- Promise actors: `fromPromise(({ input, signal }) => …)`; `signal` aborts when the actor receives `stop`, so a long-running `spawnAgent` is cancellable. [2]
- Persistence: `actor.getPersistedSnapshot()` → serializable state; restore via `createActor(logic, { snapshot }).start()` — the basis for durable human gates. [1]
- Inspection: `createActor(machine, { inspect })` observes `@xstate.actor` / `@xstate.snapshot` / `@xstate.event` — the monitor's lifecycle feed. [3]

## Module: one `graph/` dir

The runtime is replaced, not extended alongside, so the end state is a single module: `git mv src/workflow → src/graph`. History is preserved, reused files stay put, and there is no `../workflow` cross-import to a half-dead dir. The subagent **execution core** outside this module (`src/agent-manager.ts`, `agent-runner.ts`, `structured-output.ts`, `usage.ts`, model/settings resolution) is untouched.

Almost every file in the module changes; only three are pure deletes. Fate of each current `src/workflow/` file (all paths below become `src/graph/`):

| File | Fate | Why |
|---|---|---|
| `worker-source.ts` | **delete** | the VM worker; no user JS runs |
| `meta.ts` | **delete** | parses `export const meta` from a JS script; graph meta is JSON |
| `runtime.ts` | **rewrite** | worker + semaphore + script journal removed; scheduling → `scheduler.ts` + `workflow-actor.ts` |
| `host.ts` | **reuse core, rework interface** | `AgentManager` seam stays; drop script `loadWorkflow`, feed the node actor |
| `json-schema.ts` | **reuse as-is** | node output schema validation |
| `outcome.ts` | **reuse** (key may rename) | a graph run still emits an outcome |
| `journal.ts` | **rewrite** | key by node id, not call position; basis for durable gate/resume |
| `progress.ts` | **rewrite** | node/edge runtime state replaces the linear agent-entry log |
| `saved.ts` | **adapt** | resolve `.graph.json` + validate a graph, not a `meta` block |
| `task.ts` | **adapt** | `agent_graph` also returns a task id and runs async |
| `entry.ts` / `entry-validation.ts` | **adapt** | transcript snapshot follows the new progress shape |
| `collisions.ts` | **adapt** | foreign-tool conflict check, new tool name |
| `notification.ts` | **adapt** | completion text / large-result artifact still needed |
| `tool-description.ts` | **rewrite** | `agent_graph` description + new skill path |
| `pane/*` | **adapt (significant)** | monitor: tree → graph render |
| `../index.ts` | **edit** | register `agent_graph`, drop `SubagentWorkflow` |

New files: `ir.ts`, `validate.ts`, `node-actor.ts`, `scheduler.ts`, `workflow-actor.ts`, `persist.ts`.

## Phases

Each phase is independently verifiable and leaves the test tree green. P0 renames the module and removes the three script-only files up front — their only consumers (the two discarded scripts and the old tool) leave with them — then later phases refactor the reused files in place. The `agent_graph` tool is not user-facing until P6; that is fine on a feature branch.

### P0 — IR + validator (pure data)
- Add `xstate` to the workspace catalog + `extensions/subagents`.
- `git mv src/workflow → src/graph`; delete `worker-source.ts`, `meta.ts`, and the script core of `runtime.ts`; drop the old `SubagentWorkflow` tool registration and the `subagent-workflows` skill.
- `src/graph/ir.ts`: `AgentGraph`, `GraphNode` (`agent` | `human_gate` | `graph` | `expand`), `GraphEdge`, `Condition`, `ValueRef` (canonical `{ node, path }`).
- `src/graph/validate.ts`: schema + structural checks (unique node ids, edge references resolve, allowed node/condition shapes, loop limits, graph-size/nesting caps).
- **Acceptance:** valid/invalid graph fixtures accept/reject with precise messages; tree green after the rename with the old runtime removed.
- **Verify:** `pnpm test:extensions`, `pnpm lint:typecheck`.

### P1 — Node execution on XState
- `src/graph/node-actor.ts`: an agent node as `fromPromise` wrapping `host.spawnAgent`, cancellation via `signal`. Reuse the `host.ts` core; its interface is reworked to feed the node actor, not a script.
- Wire `onResolved` → node runtime state (recordId/model/thinking), same reporter `host.ts` already calls.
- **Acceptance:** a one-node graph runs an agent and returns typed output; stopping the actor aborts the child.
- **Verify:** unit (stub host) + one real-provider e2e mirroring existing `agent-runner-e2e` patterns.

### P2 — WorkflowActor + scheduler
- `src/graph/scheduler.ts`: dependency readiness (`pending → ready → running → settled`), global concurrency admission, condition evaluation on edges, typed input/output wiring (`ValueRef` resolution), bounded loops (`loopPolicy.maxIterations`).
- `src/graph/workflow-actor.ts`: parent actor supervising node actors; `PAUSE`/`RESUME`, per-node `skip`/`retry` (replacing the old index-based controls).
- **Acceptance:** a review→fix→review loop and a classify→route branch both execute; a false condition skips its edge; loop cap terminates.
- **Verify:** unit tests over deterministic stub node logic; assert edge-condition truth and loop bounds.

### P3 — Typed outputs + validation classes
- Reuse `json-schema.ts` for schema validation on node completion.
- Deterministic validation = gate command via `host.runGate` (no `action` node).
- Agent validation = an ordinary agent node, visible in the graph.
- Node lifecycle `running → validating → (valid → completed | invalid → retry/repair/fail)`.
- **Acceptance:** schema mismatch drives retry/fail per `validation`/`retry` policy; gate failure blocks completion.
- **Verify:** unit tests for each validation class; reuse `applySchema` behavior.

### P4 — Human gate node + durable persistence (highest risk)
- `human_gate` node pauses the run; persist via `getPersistedSnapshot()` to disk (extend the journal), restore with `createActor(logic, { snapshot })` on a later session.
- This is **new persistence scope** — current resume is same-session only.
- **Acceptance:** pause at a gate, end the session, restart, resume the waiting run and complete it.
- **Verify:** unit test round-tripping a persisted snapshot; one manual restart check documented here.

### P5 — Monitor (tree → graph)
- `RunGraphState` / `NodeRuntimeState` fed by XState `inspect` events plus graph-runtime domain data (tokens, model, validation, output preview).
- Adapt `pane/*` to render topology + conditional-edge truth + dynamically added nodes; keep the current tree renderer as fallback until the graph view is proven.
- **Acceptance:** monitor shows nodes/edges/status live, marks conditions true/false, and shows expanded nodes appear immediately.
- **Verify:** `workflow-pane-*` test analogues over the new state shape.

### P6 — Tool surface (`agent_graph`)
- Register `agent_graph` in `src/index.ts` accepting `{ graph: savedRef | inlineGraph, input }`; reuse `saved.ts` resolution against `.pi/agent-graphs/**/*.graph.json`.
- Preserve the opt-in / `setActiveTools` gating and delegation restrictions the current tool carries.
- Rewrite the authoring skill for graph files (author → validate → run → debug).
- **Acceptance:** saved-ref and inline graphs both run through one tool; validation errors surface before any actor starts.
- **Verify:** tool-registration + tool-rendering test analogues.

### P7 — Subgraph, expand, resources (primitives; consumers deferred)
- `graph` (subgraph) node composes a saved graph. `expand` node validates a `GraphFragment` and inserts it **atomically** into the `RunGraph` guarded by a single scheduler tick.
- Named resource capacities: extend global concurrency to per-resource semaphores (`{ "workspace:main": { capacity: 1 } }`).
- **Acceptance:** an expand inserts nodes mid-run with stable identities across retry; a capacity-1 resource serializes two otherwise-parallel nodes.
- **Verify:** unit tests for atomic insertion and resource serialization.

### P8 — Cutover + cleanup
- Confirm the two scripts (`deep-research.js`, `last30days.js`) are gone (discarded in scope; no port). The old runtime files were already removed in P0.
- Remove any transitional shims; ensure `agent_graph` is the only execution tool and the module is fully `src/graph/`.
- **Acceptance:** no references to the old script runtime, `SubagentWorkflow`, or `worker-source` remain; full suite green.
- **Verify:** `pnpm test:extensions`, `pnpm lint:typecheck`, `rg` for dangling `SubagentWorkflow` / `worker-source` / `../workflow` references.

## Open questions to resolve during build (from design §2.7)

- Atomic expansion while nodes run → single scheduler tick inside the WorkflowActor (P7).
- Stable node identity across resume/retry → carry the journal-key concept onto graph nodes (P2/P4).
- Condition-language sufficiency → prove against the P2 review-loop and classify-route cases; grow only on demand.
- JSON Schema node contracts vs prompt/runtime overhead → measure in P3 before widening.
- Subgraph input/output namespacing → decide a prefix scheme in P7.
- Which XState snapshot to persist vs journal → persist actor snapshot for structure; keep domain data (tokens/model/output) in the graph journal (P4/P5).

## Risk register

- **Durable-restart human gate (P4)** — genuinely new; isolate and prove with a persisted-snapshot round-trip before depending on it.
- **Regressing hard-won semantics** — skip/retry windows, abort propagation, replay-by-identity. Mitigation: keep the `host.ts` core intact; port only the semantics that survive the model change as graph tests.
- **Monitor rewrite** — keep the tree renderer until the graph view is proven (P5).
- **XState debugging surface** — confine XState to lifecycle/abort/inspection; keep IR, scheduler, validation, and wiring as plain host code.

## Verification strategy

- Per phase: focused unit tests (stub `host`) + `pnpm test:extensions` + `pnpm lint:typecheck`.
- Real-provider e2e only where an agent node is exercised, following existing `*-e2e.test.ts` patterns.
- P4 and P8 additionally require the documented manual restart / dangling-reference checks.

---

Sources:
[1] Persistence — XState docs (https://stately.ai/docs/persistence)
[2] fromPromise — XState API, provide AbortSignal (https://statelyai-xstate.mintlify.app/api/actors/from-promise, https://github.com/statelyai/xstate/pull/4191)
[3] Inspection API — XState docs (https://dev.stately.ai/docs/inspection)
