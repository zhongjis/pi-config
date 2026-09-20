## Purpose

Run isolated Agent sessions with foreground results and background supervision.

## Ownership

- Owns agent discovery, execution, steering/resume, notifications, the typed `agent_graph` graph runtime (`src/graph/`), and local UI/tests.
- Agent definitions remain outside this runtime; shared utilities belong to [lib](../lib/AGENTS.md).
- `src/index.ts` owns activation order, manager/registry ownership, live settings/appliers, UI composition, lifecycle hooks, and registration. Extracted modules MUST NOT import it.
- `src/graph/workflow-runtime.ts` owns graph tasks/runs, session history, execution/resume/stop, the complete typed graph tool, completion snapshots, and the fleet adapter.
- `src/notification-coordinator.ts` owns held nudges, smart batches, grouped/individual delivery, and pending-nudge cancellation; lifecycle cleanup ordering remains activation-owned.
- `src/agent-tool.ts` and `src/result-tools.ts` own complete tool definitions; `src/agent-result.ts` shares foreground/retrieval/resume report semantics.
- `src/invocation-config.ts` owns shared Agent config/model/thinking/scope preparation; direct and graph callers retain their own max-turn policy, warnings, delivery, and orchestration.
- `src/ui/agents-menu.ts` owns agent navigation, conversations, CRUD, and authoring wizards. `src/ui/settings-menu.ts` owns presentation/input only; setting mutation and persistence remain in activation.

## Local Contracts

- Fresh descendants MUST inherit the parent's Agent-tree `local://` root, not its conversation by default.
- Terminal sessions remain resumable for 30 minutes in the current parent session; switch, reload, or shutdown may clean them sooner.
- Retention MUST remain bounded; resume is not durable-session availability.
- Settled graph metadata history lives in session-local OS storage keyed by the exact Pi session ID, separate from Agent-tree sharing and graph resume checkpoints. Keep at most 20 unique runs, 200 nodes/run, 64 phases, 32 dependencies/node, 160-character sanitized display strings, and 8 MiB/session; evict oldest runs and disclose omitted nodes.
- History MUST contain no prompts, inputs, outputs, errors, outcome reasons, scripts, artifact paths, logs, or conversation handles. It is read-only metadata, not execution recovery. Live runs supersede same-ID snapshots in both Graph runs inspectors.
- Live graph inspectors may show optional graph descriptions, inputs, and complete retained node output; these are never copied into graph history.
- Load history before UI managers; capture completed/failed/explicit user-stopped runs before notification. Disable capture before lifecycle aborts and flush writes before replacing the session store. Unknown versions remain untouched with writes disabled; I/O failures emit only one generic warning per session.
- Rendering changes MUST preserve model-visible completion notifications and tool results. Collapsed completion notifications MUST flatten multiline previews and mark width clipping with an ellipsis; expanded previews retain their original content.
- Standalone notifications MUST use flat rows without `├─` or `└─`. Agent call headers use the foreground format in both modes; background calls append only `[background]` beside the Agent identity.
- Completion notifications use lib's passive themed custom-message shell; it MUST NOT change their content or delivery path.
- Foreground results and background follow-up notifications MUST retain distinct delivery paths.
- Foreground capacity MUST remain independent of background capacity and unlimited by default; queued blocking callers MUST settle on completion, cancellation, startup failure, or shutdown. Detached spawns and resume bypass the foreground pool.
- `reportUsage` MUST default off and report each collected delta once through final tool results, including cache reads; display-token totals stay unchanged. Disabled/session-ended pools MUST retain no pending deltas.
- QoL's live manager-cost bridge remains independent of native reported usage; NEVER add both for the same spend. `showCost` MUST affect presentation only and default off.
- Run reports MUST derive model/thinking from SDK session getters, including inherited models and clamping/off.
- Queued/pre-session reports NEVER present requested model/thinking as actual execution.
- Omitted thinking MUST use SDK selected-model defaults, NEVER parent thinking.
- `thinkingDefault` MUST track configuration intent only; unknown intent stays unlabelled.
- `thinking: default (pending)` MUST survive queued retrieval until session metadata replaces it; resume retains session thinking.
- Foreground, retrieval, and resume MUST share structured result/error, transcript, and diagnostic details.
- Compact Agent and retrieval results MUST fit within three physical rows: status plus primary preview without redundant labels; available model (without `model:`) and thinking; configured expand hint. Queued IDs/next actions and pending thinking remain visible within the width budget.
- Turns, soft limit, tools, tokens, duration, estimated cost, and requested/effective discrepancies MUST appear only expanded; expanded reports retain complete answer/error before metadata and artifacts. Zero/unpriced costs stay omitted.
- Request provenance MUST survive resume; diagnostic model resolution MUST preserve execution policy and treat equivalent fuzzy identities as equal.
- Runtime diagnostics MUST remain visible expanded without counting as tool executions; expanded Run MUST explicitly show zero tools.
- Legacy/malformed details MUST retain full raw content expanded and obey the compact row budget.
- Runtime metadata MUST preserve non-runtime invocation tags; resume turns MUST count `turn_end`, not usage messages.
- Configured model chains MUST fail when exhausted; only absent model configuration inherits the parent.
- Agent advertisements MUST preserve verbatim model chains or explicit parent inheritance in full lists; compact lists omit models.
- Full/compact lists and custom placeholders MUST separate built-in and configured extension selectors, distinguish omitted/all from empty/none, and mark extensions unavailable under isolation or `extensions: false`; configuration NEVER verifies runtime loading, authentication, or permissions.
- Selected candidate `:fast` fixes Fast on; no suffix fixes off, NEVER inherited/session toggles. Validate explicit on before child creation; unsupported capability MUST NOT trigger fallback selection. Preserve selected metadata through Agent/RPC/manager/runner; direct model options MUST NOT bypass frontmatter.
- Hidden `subagent-fast` hooks MUST survive isolation/excludes and remove discovered interactive `fast` copies. Apply strict request-local metadata without shared-model mutation, including after OAuth drift; provider errors surface normally. Resume retains the original captured policy.
- Final answers at the soft turn limit MUST complete normally; unfinished tool turns receive wrap-up steering.
- `workflowsEnabled` MUST default false; disabled workflows MUST add no tool schema or workflow prompt cost. Settings changes require reload for registration.
- Graph authoring guidance MUST live in bundled `skills/agent-graphs/SKILL.md`, with detailed dynamic fanout guidance in its [reference](skills/agent-graphs/references/dynamic-expansion.md); discover it through native `resources_discover` only when workflows are enabled, and NEVER advertise it through package metadata or personal skill installation.
- The graph tool description MUST point to the resolved bundled skill; reading/invoking this authoring skill MUST NOT grant execution opt-in. Agent roster authority remains the current Agent tool description.
- A graph is validated before any node runs; conditions, ValueRef wiring, and outputs MUST depend only on validated structured node output, never on an agent's prose. An unmapped `${placeholder}` is a validation error.
- `fanout` MUST atomically materialize validated typed items as ordinary agent children, await every terminal child, and return input-ordered all-settled results. Generated children use stable `<fanout-id>:item:<index>` IDs and inherit fanout phase metadata.
- Durable graph snapshot writes MUST use same-directory temporary files, file sync, atomic rename, and directory sync where supported; an I/O failure MUST leave a complete prior or new checkpoint. Atomic replacement does not guarantee exactly-once external effects.
- Graph v2 separates authored keys and optional non-unique names from run-scoped UUID-v4 instance identities. Manifests and continuation intent MUST be checkpointed before dispatch; retry/restore retain IDs and fresh runs allocate new ones. V1 snapshots upgrade atomically before dispatch; corrupt/unknown versions fail closed.
- Snapshot IDs MUST match their filenames and the workflow-ID grammar; reject symlinked checkpoint paths. Before resume creates a task, acquires a lease, writes, or dispatches, validate scheduler/graph state and recursively re-authorize persisted nested graphs against current delegation policy.
- Checkpoint replacement MUST preserve admitted definitions, UUID/provenance, settled evidence and completed feedback-history prefixes, not just revisions. Nested invocation history and complete recursive ordinal mappings remain durable; evaluator attempts/repair budgets cannot reset on restore. Explicit cancellation is terminal; lifecycle interruption remains resumable.
- `bounded_feedback` owns only fixed fanout/evaluator templates, typed gap-linked decisions, append-only accumulation, hard bounds and no-progress termination. The [v2 authoring contract](skills/agent-graphs/references/bounded-feedback.md) owns schema/results, persistence and optional deadline/spend bounds. Deadline uses the durable run start; spend uses reported child lifetime USD costs, including evaluator repairs, never token estimates. Check before initial materialization, before continuation intent and before restored-intent allocation/dispatch; missing settled-execution accounting MUST stop growth with partial evidence. Restore MUST retain start/costs and fresh replay MUST start anew.
- V2 monitor rows MUST come from committed manifests, use name-first iteration/item labels, retain binding/key/UUID in detail data, and follow persisted materialization ordinals rather than topology stages or UUID sorting.
- Completion notifications MUST disclose execution and child settlement independently, prioritizing execution failure; delivery timing/channels remain unchanged.
- Graph runs MUST NOT bypass delegation permissions: the `agent_graph` tool pre-flights every node agent (recursing resolvable subgraphs, guarding cycles) against the same delegation gate the manager enforces, and rejects a disallowed graph as a tool error before any task or spawn; a spawn denied mid-run MUST fail that node, never crash the run. Pool accounting and child ownership MUST remain independent; owned children MUST NOT receive recursive orchestration tools.
- There is no filesystem isolation backend. A node's validation gate MUST run in the effective child cwd; NEVER add automatic branches, commits, or filesystem copies.
- Full-result artifacts for truncated notifications persist in the ephemeral session task area; artifact failures MUST remain visible. Execution is not a sandbox, transaction, rollback, or cross-session recovery guarantee.
- Graph-run transcript presentation MUST follow [the presentation spec](../../docs/specs/workflow-tool-output-presentation.md): three-row collapsed reports, structural result summaries, active task/type identity, and complete phase-grouped rosters; telemetry belongs expanded.
- Completion notification snapshots MUST retain complete returned content and actual artifact outcomes independently of live task lookup. Expanded reports MUST put Activity/Result/Error before metadata and preserve retained child details/logs separately. Legacy/malformed data retains raw output; no new durable recovery or artifact writes.
- Inspector supervision MUST keep one stable phase-grouped roster with explicit states, state-first detail, responsive wide/narrow navigation, and contextual pause/skip/retry/cancel/conversation controls; skips MUST settle while paused, and usage MUST retain all retry attempts. Normal rows show only effective session models, `model pending` before resolution, and never requested chains. Ordinary agent lists MUST hide owned children; FleetView represents each graph run with one row.
- Preserve the original `v0.14.3` provenance separately from the full `v0.19.0` workflow import and lowercase-name collision fix recorded in [README](README.md#upstream).

## Work Guidance

- You MUST preserve upstream execution contracts and [README Local Tweaks](README.md#local-tweaks).
- [README](README.md) owns configuration, supervision, and storage behavior; NEVER infer disk isolation from transcript settings alone.
- You MUST preserve the [MIT license](LICENSE) and [pinned provenance](README.md#upstream).

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/subagents/test`.
- [Agent manager](test/agent-manager.test.ts) covers retention; [notification rendering](test/notification-rendering.test.ts) covers presentation.
- `test/graph-history*.test.ts` covers metadata privacy/bounds, exact-session reload/isolation, lifecycle suppression, and read-only inspector adapters.
- `test/workflow-registration.test.ts` checks enabled-only skill discovery and `agent_graph` tool registration; `test/graph-tool.test.ts` drives the tool end to end, `test/graph-delegation-preflight.test.ts` covers the pre-run delegation gate, and `test/graph-portfolio.test.ts` validates the saved reusable-workflow graphs.
- `test/graph-restore-security.test.ts`, `test/graph-resume-authorization.test.ts`, `test/graph-checkpoint-owner.test.ts`, and `test/graph-checkpoint-transitions.test.ts` cover untrusted restore, side-effect ordering, owner recovery, and append-only replacement.
- Graph QA MUST use a fresh Pi session through `interactive_shell`, running a saved graph and inspecting the tool call, the monitor, node ordering, and completion evidence.
- Root unit selection excludes e2e-named tests; those require separate runtime verification.
- `pnpm exec vitest run --project subagents-e2e extensions/subagents/test/controls-runtime-e2e.test.ts` verifies native usage aggregation, retained request provenance, and queued inline completion.

## Child DOX Index

- None; this document owns the entire runtime subtree.
