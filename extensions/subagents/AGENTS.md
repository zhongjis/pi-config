## Purpose

Run isolated Agent sessions with foreground results and background supervision. See [CONTEXT.md](CONTEXT.md) for agent-graph terminology.

## Ownership

- Owns agent discovery, execution, steering/resume, notifications, the typed `agent_graph` graph runtime (`src/graph/`), and local UI/tests.
- Agent definitions remain outside this runtime; shared utilities belong to [lib](../lib/AGENTS.md).
- `src/index.ts` owns activation order, manager/registry ownership, live settings/appliers, UI composition, lifecycle hooks, and registration. Extracted modules MUST NOT import it.
- Only the activation that owns the manager registry MAY mutate shared lifecycle state; non-owning child activations still register tools, no-op start/switch, and dispose only their local manager, fleet, widget, notifications, and usage state on shutdown.
- `src/graph/graph-runtime.ts` owns graph tasks/runs, session history, execution/resume/stop, typed graph tools, completion snapshots, and the fleet adapter. `gate-handoff.ts` owns correlated human requests and response receipts; `gate-tool.ts` owns resolution registration; `gate-notifications.ts` owns held actionable nudges.
- `src/graph/graph-actor.ts` owns the root run lifecycle, native child hierarchy, serialized persistence, control acknowledgments, and drain-before-terminal selection; its context is an owned mutable aggregate ([ADR 0004](../../docs/adr/0004-graph-actor-context-is-an-owned-mutable-aggregate.md)). `run-graph.ts` is only the create/start, AbortSignal bridge, `toPromise`, and cleanup adapter.
- `node-lifecycle.ts` owns typed agent/human lifecycle machines; `node-effects.ts` owns single spawn/gate/prompt invokes. `graph-domain.ts` owns the single `SchedulerState` projection and applies root-selected transactions. `graph-planner.ts` queries are pure; `GraphProjection` is a read-through view, not a second lifecycle/status map.
- `subgraph-actor.ts`, `expand-actor.ts`, `fanout-actor.ts`, and `feedback-actor.ts` own volatile coordinator sequencing; root transactions remain the sole planner, topology, checkpoint, control, and terminal authority. `bounded-feedback.ts` retains pure durable types, decision/schema validation, bounds, continuation, and terminal proposals.
- Native typed child ownership retains capacity and excludes same-ID admission through settlement ACK, RELEASE_READY, RELEASE, and RELEASED. Root removes children/journals only after explicit release completion or physical failure drain. Cancellation persists exact disposition before CANCEL; pending gate/repair requests still receive ACK without follow-up effects. Durable cancellation supersedes an already-in-flight normal settlement proposal.
- `src/agent-tool-scope.ts` owns subagent tool-scope enforcement (keeping the ceiling tool active after bind and on `turn_end`, and the `beforeToolCall` veto); `src/agent-runner.ts` owns rule-driven extension loading, including Pi built-in extension factories (codemode, tool-search, mcp), the hidden `subagent-nested-tool-scope` hook that blocks nested (codemode-script) calls outside `tools:`, and the `subagent_tool_ceiling` that hides ungranted declarations from the first turn.
- `src/agent-manager.ts` `disposeChildSession` owns child disposal: emit `session_shutdown` (reason `quit`) once, then dispose even if a handler fails. Child settings MUST honor the parent's project trust.
- `src/agent-runner.ts` owns canonical read-only Bash guard selection; Huayan reuses its trusted hidden guard.

## Local Contracts

- Fresh descendants MUST inherit the parent's Agent-tree `local://` root, not its conversation by default.
- Waiting retrieval MUST await physical settlement even when the visible record is already stopped, without cancelling the underlying execution; retain execution-ID protection across the wait. Non-waiting retrieval MUST NOT consume completion while the manager owns the execution. `hasRunning` MUST remain true through physical drain; the manager's runs map, not visible status, owns pending execution.
- Runner settlement MUST await SDK idle even after prompt rejection or cancellation. Manager waiters, capacity, same-session exclusion, and session disposal MUST retain physical run ownership until settlement; stopped status alone is not drain. Failure results retain only the current execution's partial text, never prior-turn output.
- Retention MUST remain bounded; resume is not durable-session availability. Reload-surviving monitor history is a read-only roster, not a resume target.
- History version 2 MAY retain sanitized display topology only: configured graph description, node kind/name/role, history-local parent/dependency/connection indices, iteration/item position, and feedback decision enums. It MUST contain no prompts, inputs, outputs, errors, outcome reasons, scripts, artifact paths, logs, bindings, UUIDs, runtime instance IDs, or conversation handles.
- Foreground results and background follow-up notifications MUST retain distinct delivery paths.
- A graph is validated before any node runs; conditions, ValueRef wiring, and outputs MUST depend only on validated structured node output, never on an agent's prose. An unmapped `${placeholder}` is a validation error.
- Root admission waves MUST checkpoint before native child creation. Settlement MUST use one delayed self-FLUSH per generation, checkpoint the bounded outcome/cost/drain batch, and only then remove children. Pause blocks admission, not settlement or pending skips. Control acknowledgments MUST use unique tokens and reject reentrant mutation/writer calls before sending; rejected controls MUST enqueue nothing.
- The first infrastructure error MUST prohibit further dispatch/writes, cancel children, and propagate unchanged through `toPromise` only after physical drain. Cancellation during initialization MUST NOT bypass validation/reconciliation. Callbacks and monitor publications MUST execute outside mutation actions, after their checkpoints commit.
- Graph cancellation requests MUST retain admitted concurrency/resource capacity until host execution physically settles, including rejection and non-abortable human prompts. Skip/retry replacements wait for drain; whole-run completion waits for drain and host disposal. Post-abort awaits MUST NOT trigger gates, repairs, failure callbacks, or cost accounting.
- Graph execution protocol v1 uses an append-only ledger correlated by run, instance, activation, graph attempt, and execution attempt. Internal repairs consume the ledger budget without incrementing graph starts. Batch ready admission/dispatch intents before effects and outcome/cost/live-drain settlement before capacity release; checkpoints are synchronous safety boundaries, never monitor updates. Runtime indexes are transient; full validation remains at restore/replacement boundaries.
- Validate legacy state before migration and checkpoint migration before callbacks/dispatch. Recovery drains require proven dead-writer ownership plus positive host reconciliation; validation-shell effects fail closed. Recheck live delegation and gate capabilities at dispatch; non-durable correlation stays transient.
- Cancellation intent MUST durably distinguish `skip`, `retry`, `lifecycle`, and `cancel` before stopping effects. Restore applies only the latest matching drained execution's disposition: skip is terminal, retry/lifecycle restart the same activation in a new graph attempt (`restore` labels lifecycle), and whole-run cancel remains terminal. Old dispositions and presentation labels MUST NOT replenish a newer execution's budget.
- Durable graph snapshot writes MUST use same-directory temporary files, file sync, atomic rename, and directory sync where supported; an I/O failure MUST leave a complete prior or new checkpoint. Atomic replacement does not guarantee exactly-once external effects.
- Graphs separate authored keys and optional non-unique names from run-scoped UUID-v4 instance identities. Manifests and continuation intent MUST be checkpointed before dispatch; retry/restore retain IDs and fresh runs allocate new ones. V1 snapshots upgrade atomically before dispatch; corrupt/unknown versions fail closed.
- Snapshot IDs MUST match their filenames and the graph-run ID grammar; reject symlinked checkpoint paths. Checkpoints retain their originating exact Pi session ID across writes; automatic resume silently skips foreign and ownerless snapshots before creating tasks, acquiring leases, or dispatching. Same-session recovery retains the exclusive writer lease. Validate scheduler/graph state and recursively re-authorize persisted nested graphs against current delegation policy before resuming.
- Checkpoint replacement MUST preserve admitted definitions, UUID/provenance, settled evidence and completed feedback-history prefixes, not just revisions. Nested invocation history and complete recursive ordinal mappings remain durable; evaluator attempts/repair budgets cannot reset on restore. Restore MUST reconstruct nonterminal feedback owners as running before the first replacement checkpoint. Never-admitted feedback skips MUST persist a terminal `skipped before admission` result with zero attempts and skipped scheduler status; pre-admission cancellation also stays skipped with zero attempts but retains reason `cancellation`. Skip batches and explicit cancellation MUST checkpoint only coherent feedback ownership; terminal restore MUST NOT dispatch. Explicit cancellation is terminal; lifecycle interruption remains resumable.
- Graph runs MUST NOT bypass delegation permissions: the `agent_graph` tool pre-flights every node agent (recursing resolvable subgraphs, guarding cycles) against the same delegation gate the manager enforces, and rejects a disallowed graph as a tool error before any task or spawn; a spawn denied mid-run MUST fail that node, never crash the run. Pool accounting and child ownership MUST remain independent; owned children MUST NOT receive recursive orchestration tools.
- Graph dispatch MUST fail a node closed when its named agent is absent or disabled in the current configuration. Graph model labels MUST come from assistant messages in the matching execution, including model changes and failures; a selected session model or inherited transcript is not execution evidence. Without assistant evidence, leave the model unknown.
- There is no filesystem isolation backend. A node's validation gate MUST run in the effective child cwd; NEVER add automatic branches, commits, or filesystem copies.
- Full-result artifacts for truncated notifications persist in the ephemeral session task area; artifact failures MUST remain visible. Execution is not a sandbox, transaction, rollback, or cross-session recovery guarantee.

## Work Guidance

- [README](README.md) owns configuration, supervision, and storage behavior; NEVER infer disk isolation from transcript settings alone.
- You MUST preserve the [MIT license](LICENSE) and the [README attribution](README.md#attribution).

- Changing lifecycle, interruption provenance, activity, retention, queuing, resume, structured capture, result retrieval, delayed notifications, or retrieval call headers? You MUST read [Native Agent lifecycle](MAINTENANCE.md#native-agent-lifecycle).
- Changing configuration preparation, tool exposure, delegation hints, agent advertisements, model chains, thinking, Fast, usage, or cost? You MUST read [Invocation and model policy](MAINTENANCE.md#invocation-and-model-policy).
- Changing graph registration, skill discovery, saved resolution, ValueRefs, semantic policies, or repair prompts? You MUST read [Graph tools and validation](MAINTENANCE.md#graph-tools-and-validation).
- Changing root scheduling, NODE receipts, control acknowledgments, child release, nested graph actors, or checkpoint relays? You MUST read [Root and nested actor protocols](MAINTENANCE.md#root-and-nested-actor-protocols).
- Changing COORD receipts, expand, fanout, bounded feedback, materialization, evaluator failures, or topology bounds? You MUST read [Dynamic coordinators and feedback](MAINTENANCE.md#dynamic-coordinators-and-feedback).
- Changing checkpoint formats, migrations, manifests, leases, reconciliation, dispositions, or restore? You MUST read [Checkpoint and restore behavior](MAINTENANCE.md#checkpoint-and-restore-behavior).
- Changing independent-agent history, graph history, capture ordering, privacy, or historical artifact lookup? You MUST read [Session history and artifacts](MAINTENANCE.md#session-history-and-artifacts).
- Changing human requests, gate resolution, gate nudges, decision gates, or hybrid escalation? You MUST read [Human and decision gates](MAINTENANCE.md#human-and-decision-gates).
- Changing tool rows, widgets, notifications, UI settings, monitors, inspectors, conversation viewers, or graph model labels? You MUST read [Presentation and notifications](MAINTENANCE.md#presentation-and-notifications).
- Changing trace artifacts, runtime inspection, or display-only replay? You MUST read [Trace and replay](MAINTENANCE.md#trace-and-replay).

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/subagents/test`.
- Focused tests live in [test/](test/) and are named by area (for example `graph-*`, `agent-history*`, `gate-*`); run the matching files for the area you change.
- Cancellation fixtures MUST explicitly settle parked hosts after asserting the run remains pending.
- Graph QA MUST use a fresh Pi session through `interactive_shell`, running a saved graph and inspecting the tool call, the monitor, node ordering, and completion evidence.
- Root unit selection excludes e2e-named tests; those require separate runtime verification.
- `pnpm exec vitest run --project subagents-e2e extensions/subagents/test/controls-runtime-e2e.test.ts` verifies native usage aggregation, retained request provenance, and queued inline completion.

## Child DOX Index

- None; this document owns the entire runtime subtree.
