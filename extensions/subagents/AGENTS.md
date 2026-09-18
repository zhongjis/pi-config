## Purpose

Run isolated Agent sessions with foreground results and background supervision.

## Ownership

- Owns agent discovery, execution, steering/resume, notifications, the typed `agent_graph` graph runtime (`src/graph/`), and local UI/tests.
- Agent definitions remain outside this runtime; shared utilities belong to [lib](../lib/AGENTS.md).

## Local Contracts

- Fresh descendants MUST inherit the parent's Agent-tree `local://` root, not its conversation by default.
- Terminal sessions remain resumable for 30 minutes in the current parent session; switch, reload, or shutdown may clean them sooner.
- Retention MUST remain bounded; resume is not durable-session availability.
- Settled graph metadata history lives in session-local OS storage keyed by the exact Pi session ID, separate from Agent-tree sharing and graph resume checkpoints. Keep at most 20 unique runs, 200 nodes/run, 64 phases, 32 dependencies/node, 160-character sanitized display strings, and 8 MiB/session; evict oldest runs and disclose omitted nodes.
- History MUST contain no prompts, inputs, outputs, errors, outcome reasons, scripts, artifact paths, logs, or conversation handles. It is read-only metadata, not execution recovery. Live runs supersede same-ID snapshots in both Graph runs inspectors.
- Live graph inspectors may show optional graph descriptions, inputs, and complete retained node output; these are never copied into graph history.
- Load history before UI managers; capture completed/failed/explicit user-stopped runs before notification. Disable capture before lifecycle aborts and flush writes before replacing the session store. Unknown versions remain untouched with writes disabled; I/O failures emit only one generic warning per session.
- Rendering changes MUST preserve model-visible completion notifications and tool results. Collapsed completion notifications MUST flatten multiline previews and mark width clipping with an ellipsis; expanded previews retain their original content.
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
- Graph authoring guidance MUST live in bundled `skills/agent-graphs/SKILL.md`, discovered through native `resources_discover` only when workflows are enabled; NEVER advertise it through package metadata or personal skill installation.
- The graph tool description MUST point to the resolved bundled skill; reading/invoking this authoring skill MUST NOT grant execution opt-in. Agent roster authority remains the current Agent tool description.
- A graph is validated before any node runs; conditions, ValueRef wiring, and outputs MUST depend only on validated structured node output, never on an agent's prose. An unmapped `${placeholder}` is a validation error.
- Completion notifications MUST disclose execution and child settlement independently, prioritizing execution failure; delivery timing/channels remain unchanged.
- Graph runs MUST NOT bypass delegation permissions. Pool accounting and child ownership MUST remain independent; owned children MUST NOT receive recursive orchestration tools.
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
- `test/workflow-registration.test.ts` checks enabled-only skill discovery and `agent_graph` tool registration; `test/graph-tool.test.ts` drives the tool end to end, and `test/graph-portfolio.test.ts` validates the saved reusable-workflow graphs.
- Graph QA MUST use a fresh Pi session through `interactive_shell`, running a saved graph and inspecting the tool call, the monitor, node ordering, and completion evidence.
- Root unit selection excludes e2e-named tests; those require separate runtime verification.
- `pnpm exec vitest run --project subagents-e2e extensions/subagents/test/controls-runtime-e2e.test.ts` verifies native usage aggregation, retained request provenance, and queued inline completion.

## Child DOX Index

- None; this document owns the entire runtime subtree.
