## Purpose

Run isolated Agent sessions with foreground results and background supervision.

## Ownership

- Owns agent discovery, execution, steering/resume, notifications, scripted workflows (`src/workflow/`), and local UI/tests.
- Agent definitions remain outside this runtime; shared utilities belong to [lib](../lib/AGENTS.md).

## Local Contracts

- Fresh descendants MUST inherit the parent's Agent-tree `local://` root, not its conversation by default.
- Terminal sessions remain resumable for 30 minutes in the current parent session; switch, reload, or shutdown may clean them sooner.
- Retention MUST remain bounded; resume is not durable-session availability.
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
- Workflow authoring guidance MUST live in bundled `skills/subagent-workflows/SKILL.md`, discovered through native `resources_discover` only when workflows are enabled; NEVER advertise it through package metadata or personal skill installation.
- The short workflow description MUST point to the resolved bundled skill; reading/invoking this authoring skill MUST NOT grant execution opt-in. Agent roster authority remains the current Agent tool description.
- The authoring skill MUST remain self-contained with acceptance-first steps, complete runnable JavaScript examples, and the full API/replay contract. Preserve imported provenance, not verbatim prose. MUST distinguish execution opt-in from action authorization, retain null/falsy coverage, bound attempts, and verify authoritative evidence without weakening criteria.
- Evidence examples MUST separate missing from rejected results; either blocks required acceptance, while optional gaps remain visible. Readers/verifiers MUST use a caller-supplied live-roster read-only selector checked before spawning; prompt guidance is not permissions, and gates remain separately authorized outside agent tool restrictions.
- Workflow authoring guidance MUST distinguish local schema validity from provider acceptance, retain provider-rejected semantic checks in workflow code, canary changed provider-facing schemas before fan-out, require atomic requirement-scoped evidence claims, and diagnose asynchronous failures from retained child details.
- Workflows MUST support model-authored inline/file/named scripts, arguments, same-session journal prefix replay (`pipeline`/`parallel` auto-assign stable per-child replay identities and `agent({key})` sets one explicitly, so replay survives the completion-order reshuffle concurrent helpers produce), parallel/pipeline execution, structured output, gates, and one-level saved-workflow composition. Ship extension code and test fixtures, not reusable workflows or research deliverables.
- Workflow tool admission MUST reject source/resume, static/full-body compile, and declared `meta.inputSchema` errors before run allocation or side effects; NEVER execute the body during admission. Runtime failures remain asynchronous.
- Optional pure-JSON `meta.inputSchema` validates effective invocation args with any root type; agent output schemas remain object-root only. Omitted resume args reuse prior args; explicit null overrides them, including against edited schemas.
- Workflow effort MUST follow local thinking authority (frontmatter → model-chain suffix → invocation → SDK default); preserve ordered model chains, `:fast`, `local://`, retention, and usage controls.
- Workflows MUST NOT bypass delegation permissions. Workflow pool accounting and child ownership MUST remain independent; owned children MUST NOT receive recursive workflow tools.
- There is no filesystem isolation backend: workflow isolation options MUST be rejected. Gates MUST run in the effective child cwd; NEVER add automatic branches, commits, or filesystem copies.
- Scripts, journals, and full-result artifacts for truncated notifications persist in the ephemeral session task area; artifact failures MUST remain visible. Prefix replay MUST stay within the same session; execution is not a sandbox, transaction, rollback, or cross-session recovery guarantee.
- Workflow transcript presentation MUST follow [the workflow spec](../../docs/specs/workflow-tool-output-presentation.md): three-row collapsed reports, structural result summaries, active task/type identity, and complete phase-grouped terminal rosters; telemetry belongs expanded.
- Workflow notification snapshots MUST retain complete returned content and actual artifact outcomes independently of live task lookup. Expanded reports MUST put Activity/Result/Error before metadata and preserve retained child details/logs separately. Legacy/malformed data retains raw output; no new durable recovery or artifact writes.
- Inspector supervision MUST support pause/skip/retry/cancel; skips MUST settle while paused, and usage MUST retain all retry attempts. Ordinary agent lists MUST hide owned children; FleetView represents each workflow with one row. CLI file execution uses `--subagents-workflow-file`.
- Preserve the original `v0.14.3` provenance separately from the full `v0.19.0` workflow import and lowercase-name collision fix recorded in [README](README.md#upstream).

## Work Guidance

- You MUST preserve upstream execution contracts and [README Local Tweaks](README.md#local-tweaks).
- [README](README.md) owns configuration, supervision, and storage behavior; NEVER infer disk isolation from transcript settings alone.
- You MUST preserve the [MIT license](LICENSE) and [pinned provenance](README.md#upstream).

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/subagents/test`.
- [Agent manager](test/agent-manager.test.ts) covers retention; [notification rendering](test/notification-rendering.test.ts) covers presentation.
- `test/workflow-registration.test.ts` checks enabled-only skill discovery and example parsing; `test/workflow-skill.test.ts` executes fenced examples with mock hosts to check coverage, failed verification, and bounded termination.
- Workflow QA MUST use a fresh Pi session through `interactive_shell`, with the model generating and executing its own script; inspect the invocation, inspector, child ordering, and completion evidence.
- Root unit selection excludes e2e-named tests; those require separate runtime verification.
- `pnpm exec vitest run --project subagents-e2e extensions/subagents/test/controls-runtime-e2e.test.ts` verifies native usage aggregation, retained request provenance, and queued inline completion.

## Child DOX Index

- None; this document owns the entire runtime subtree.
