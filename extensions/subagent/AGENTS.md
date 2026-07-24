# subagent

## Overview
Background/foreground subagent runtime: tool surface, queueing, widget UI, eventbus RPC, resume/steer support.

Vendored from [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) v0.6.3 (commit `7102b3e`). Local additions: background supervision, delegation policy, result recovery, enhanced skill-loader, abort signal forwarding, model label tracking, persistent subagent session JSONL (`SessionManager.create` with custom dir under `~/.pi/agent/subagent-sessions/`; record + notifications expose `sessionFile`), and the **C/D single-source-of-truth revamp** (`AgentRun` event stream + `ExternalContractAdapter`).

## Where to Look
| Task | Location | Notes |
|------|----------|-------|
| Runtime entry / version-guard bootstrap | `src/index.ts` | 59-line shim: factory delegates to `registerSubagentRuntime` |
| Runtime hub: tool + UI wiring, notifications | `src/lifecycle/supervision.ts` | `registerSubagentRuntime`; large central wiring file (~900 lines). Terminal `subagents:*` emission delegated to `external-contract-adapter.ts` |
| LLM tool definitions | `src/tools/` | `agent.ts`, `get_subagent_result.ts`, `steer_subagent.ts`; `stop_subagent.ts` is a reserved stub |
| Event listeners, `/agents` command, tool renderers | `src/ui-wiring/` | `messages.ts` (pi.on lifecycle), `commands.ts` (`/agents` menu + CRUD), `renderers.ts` |
| Durable background-agent registry | `src/lifecycle/registry-persistence.ts` | `appendEntry` write-through; replayed on `session_start`, survives compaction |
| Persisted resume-target metadata | `src/lifecycle/registry-persistence.ts` | Versioned parent-session entries; validated generation/revision replay and guarded write-through |
| Persisted child-session restoration | `src/session-restoration.ts` | Strict preflight, runtime compatibility, restore lock, post-open integrity revalidation, typed failures |
| Execution / resume / max-turn behavior | `src/agent-runner.ts` | Session creation + graceful wrap-up |
| Queueing / active-state bookkeeping | `src/agent-manager.ts` | Running vs queued agents |
| Cross-extension RPC | `src/cross-extension-rpc.ts` | `ping`, `spawn`, `stop` handlers |
| Single source of truth (per-run state) | `src/agent-run.ts` | `AgentRun` event-stream reducer + `waitForTerminal` + supervision snapshots + pure `toExternalEffects`; populated by `agent-manager`, read everywhere (C/D revamp) |
| Terminal compatibility + advisory boundary | `src/external-contract-adapter.ts` | Owns terminal `subagents:record` compatibility and background `subagents:completed`/`subagents:failed` advisory effects; hosts the compacted-event helper; does not own created, started, steered, settings, or ready events |
| Agent registry / custom definitions | `src/agent-types.ts`, `src/custom-agents.ts`, `src/default-agents.ts` | Unified registry with embedded defaults |
| Widget / viewer | `src/ui/` | Persistent widget + conversation viewer |
| Isolation / skill loading | `src/fs-safety.ts`, `src/skill-loader.ts` | Side systems with user-visible effects |
| Persistent settings | `src/settings.ts` | Dual-scope (global + project) settings persistence |
| Background supervision | `src/background-supervision.ts` | Auto-steer/abort idle agents (local) |
| Delegation policy | `src/delegation-policy.ts` | Allow/deny agent delegation rules (local) |
| Result recovery | `src/result-recovery.ts` | Fallback text extraction (local) |
| Regression coverage | `test/*.test.ts` | Keep behavior changes paired with tests |
| Restoration regression seams | `test/{session-restoration,agent-runner,agent-manager,bg-agent-registry-replay}.test.ts`, `test/regression/{lifecycle-contract,agent-end-notification}.test.ts` | Restore safety, typed outcomes, persistence replay, lifecycle and notification invariants |

## Commands
Run from `extensions/subagent/`.

```bash
pnpm run test
pnpm run typecheck
pnpm run lint
pnpm run build
```

## Always
- Keep background-agent UX aligned with tool contract: queue when over concurrency limit; tell callers to supervise with `get_subagent_result`, `steer_subagent`, and `resume`.
- Keep lifecycle broadcasts on `subagents:*`; keep RPC on `subagents:rpc:*` with replies on `:reply:${requestId}`.
- Use the standard reply envelope everywhere: `{ success: true, data? } | { success: false, error: string }`.
- Treat agent frontmatter as authoritative. Loader/default logic may fill omissions, but should not silently override explicit config.
- Preserve case-insensitive agent-type resolution and fuzzy model matching unless changing that behavior intentionally across docs/tests.
- Treat `Agent` invocation outcomes as a typed contract: `started_new`, `resumed_live`, `restored_session`, or `failed`. A failed explicit resume must never spawn a fresh replacement.
- Keep durable resume lookup parent-scoped and type-scoped. Persist resume-target changes through `registry-persistence.ts`; restore child JSONL only through `session-restoration.ts`.
- Authenticate the exact raw stored JSONL prefix, require direct linear suffix ancestry, allow only well-formed `session_info` after terminal snapshots, and reconcile bind-produced rows against both disk and the opened manager before continuation.
- Keep restoration changes paired with session preflight/runner/manager tests plus lifecycle and notification regression coverage; restoration must not replay spawn lifecycle events or duplicate completion notifications.
- Keep ownership split: child JSONL owns conversation bytes; `AgentLifecycleStore` exclusively assigns V1 generation/revision and delivery state; `AgentRun` owns live state; `external-contract-adapter.ts` owns terminal compatibility rows plus completed/failed effects only. Created, started, steered, and other lifecycle emissions retain their existing runtime owners.
- Keep execution behind durability barriers: running generation before provider entry and before `subagents:started`, checkpoint writes serialized under its lease, authenticated/classified suffix before current-process pending-terminal repair, terminal V1 before success, compatibility before advisory event, consumption before acknowledgement. Persistence failure must remain `failed`/`persistence_failed` while retaining fresh output without duplicate execution.

## Ask First
- Changing `subagents:*` payload shape, RPC method names, or reply envelope fields.
- Changing completion-notification timing/consolidation; notifications fire once per parent prompt at `agent_end` (parent idle), gated background-only on `!resultConsumed`/`!notified`/`!suppressNotification`/not-recently-polled.

## Never
- Never replace the eventbus RPC bridge with shared mutable globals; `tasks/` integration depends on the RPC contract.
- Never emit unscoped reply channels.
- Never separate lifecycle behavior changes from the tests that lock them down.
- Never assume any particular isolation mode; there is none.

## Gotchas
- The runtime hub is `src/lifecycle/supervision.ts` (`registerSubagentRuntime`): it owns tool/UI wiring, widget rendering, notifications, and event emission, so many changes fan out from there. `src/index.ts` is only a 59-line bootstrap + symbol version-guard.
- `subagents:ready` is the discovery signal for other extensions; breaking or delaying it causes load-order bugs.
- `prompt_mode` is parsed by both `subagent` (this extension) and `modes`. Subagent honors all three values (`replace`/`append`/`system_instructions`); modes coerces non-`append` to `replace` (see `extensions/modes/src/config-loader.ts`). When changing parser semantics in `extensions/lib/agent-frontmatter.ts`, update both consumers.
- **Single source of truth**: `record.run` (`AgentRun`) owns all run state; all writes flow `publish() → apply() → project(run, record)` — the record is a projection. The projector subscriber is installed first at spawn (agent-manager.ts) so every publish is synchronously reflected in the record before downstream subscribers see it. Supervision resolves live `record.run.activity` first for every spawn path, falling back to the legacy `agentActivity` map only when no run exists. `external-contract-adapter.ts` owns terminal `subagents:record` compatibility plus completed/failed effects only; preserve existing created/started/steered/compacted owners and frozen payloads.
- **Completion notifications** are emitted only by `emitCompletionNotificationsAtIdle` (`supervision.ts`) as a single consolidated message — NOT at completion time. Two trigger paths: (1) `pi.on("agent_end")`; (2) background supervision timer when `!parentBusy`. Gate: background terminal + unsuppressed + not-recently-polled, followed by a lease-bound serialized store check for `!resultConsumed && !notified`. Delivery order is terminal V1 → `sendMessage` outside store queue → `markNotified` → AgentRun projection. Send failure leaves `notified=false`; post-send append failure may duplicate after restart by design (at-least-once). Consumption commits `markConsumed` before RPC/tool acknowledgement. `onComplete` does widget cleanup plus terminal V1-backed compatibility append before advisory `subagents:*`; compatibility repair appends records without historical event replay.
- **Pi 0.79 session persistence** defers a fresh session's first disk flush until an assistant message. `agent-runner.ts` writes current v3 metadata and reopens the same `SessionManager` before the durable pre-prompt barrier; keep this ordering or fresh targets can fail before provider entry.
- **Recovery/rollback** stays V1-only. Resume creates `g+1/r0`; compaction, terminal, and delivery commits advance revisions through `AgentLifecycleStore`. Restart reconciles clean terminal suffixes without replay, classifies uncertain work as `unsafe_interrupted_operation`, and leaves corrupt/incompatible snapshots at the last valid row. Older V1 rollback uses unchanged highest-generation/revision replay.

## Local Tweaks

Intentional divergences from upstream. Preserve these on sync.

| File | What | Why |
|------|------|-----|
| `src/background-supervision.ts` | Local-only file | Auto-steer idle agents after timeout, auto-abort after prolonged inactivity |
| `src/delegation-policy.ts`, `src/agent-policy-denial-result.ts`, `src/tools/agent.ts`, `src/lifecycle/supervision.ts` | Versioned latest-`agent-mode` resolver; direct foreground/background/resume, RPC, and global manager-bridge authority; structured direct denial metadata; `tool_result` error promotion | Uses one validated persisted policy at every spawn-capable ingress, preserves unrestricted no-entry sessions, fails closed on identified missing/malformed policy before manager effects, keeps RPC's frozen error-only envelope with a stable denial prefix, and gives policy denials Pi's native error shell without discarding details |
| `src/result-recovery.ts` | Local-only file | Fallback text extraction from session history when `record.result` is empty |
| `src/thinking-level.ts` | Local-only file | Normalizes legacy `"none"` → `"off"` for backward compat with existing agent frontmatter |
| `src/types.ts` | Added `allowDelegationTo`, `disallowDelegationTo`, `allowNesting` to `AgentConfig` | delegation-policy.ts reads these fields |
| `src/types.ts` | Kept `modelLabel`, `waitingConsumers`, `isBackground`, `externalAbortCleanup`, `suppressNotification`, `lastSupervisionSteerAt/AbortAt` on `AgentRecord` | Background supervision + abort signal + widget display |
| `src/agent-runner.ts` | `allowNesting` gate on `EXCLUDED_TOOL_NAMES` filter | Permits nested Agent tool when frontmatter opts in |
| `src/agent-manager.ts` | External abort signal forwarding, model label/background metadata, result recovery, live-first typed resume, stable-ID durable rehydration | Clean cancellation, widget display, non-streaming provider recovery, restart-safe continuation without spawn/lifecycle replay |
| `src/custom-agents.ts` | Parses shared agent frontmatter (`builtin_tools`, `extension_tools`, delegation fields, nesting, model) via `extensions/lib/agent-frontmatter.ts`; ignores exact `AGENTS.md` context docs in agent directories | Shared schema with modes; prevents DOX/context instructions from registering as an `AGENTS` agent |
| `src/invocation-config.ts` | Uses `normalizeThinkingLevel` instead of raw cast | Thinking level compat |
| `src/skill-loader.ts` | Entire file replaced | Pi-aware discovery: SKILL.md dir skills, ancestor `.agents/skills/`, frontmatter name matching, `sourcePath`/`baseDir` metadata |
| `src/prompts.ts` | `skillBlocks` type includes `sourcePath`/`baseDir` | Enhanced skill-loader passes path metadata for relative reference resolution |
| `src/ui/agent-widget.ts` | Kept `lastProgressAt` on `AgentActivity`, `modelLabel` rendering in running/finished lines | Background supervision progress tracking, model display |
| `src/ui/agent-widget.ts`, `src/index.ts`, `src/ui/conversation-viewer.ts`, `test/agent-widget.test.ts`, `README.md` | Nerd Font UI stats: tokens `󰾆 33.8k`, turns `⟳ 5`, tool uses `󱁤 3` | Local display preference; preserve after upstream syncs |
| `extensions/lib/widget-style.ts`, `src/ui/summary-renderer.ts`, `src/ui/agent-widget.ts`, `test/summary-renderer.test.ts` | Agents widget shows per-agent compaction count (`⇲N`, hidden when 0) from `record.compactionCount` | Surface context-compaction pressure in the widget; count already collected on the record |
| `src/index.ts` | Background supervision loop + timer, delegation policy enforcement, abort signal binding, result recovery calls, model label tracking, supervision-aware wait, `suppressNotification`/`waitingConsumers` checks | All local features integrated into the main hub |
| `src/agent-manager.ts`, `src/lifecycle/supervision.ts`, `src/ui/agent-widget.ts`, `test/{agent-manager,agent-widget,index.session-context}.test.ts` | Recurring cleanup, background-supervision, and widget timers are unref'd while explicit dispose/shutdown clearing remains tested | Referenced Node.js intervals kept noninteractive `pi -p` alive after Agent completion |
| `src/agent-manager.ts`, `src/lifecycle/cleanup.ts`, `src/ui-wiring/messages.ts`, `test/agent-manager.test.ts` | Record removal and manager disposal share awaited, idempotent child teardown: detach, emit `session_shutdown` with `reason: "quit"`, then dispose even after hook failure | Releases child extension FSWatcher/LSP handles without changing normal completed-session retention or live resume |
| `index.ts` | Wrapper re-export (`export default from "./src/index.js"`) | Harness convention: entry at `extensions/<name>/index.ts` |
| `test/background-supervision.test.ts` | Local-only test | Covers supervision logic |
| `test/delegation-policy.test.ts` | Local-only test | Covers delegation allow/deny |
| `test/result-recovery.test.ts` | Local-only test | Covers fallback extraction |
| `test/index.session-context.test.ts` | Local-only test | Covers session context integration |
| `src/types.ts`, `src/agent-types.ts` | `promptMode` widened to `"replace" \| "append" \| "system_instructions"` | Adds new mode that injects AGENTS.md project context without parent role/mode body bleed |
| `src/agent-runner.ts` | `inheritContextFiles` derives from `promptMode === "system_instructions"` (overridden to false by `isolated: true`); flips `noContextFiles` so pi auto-injects AGENTS.md as `# Project Context` after `systemPromptOverride` | Single-source-of-truth AGENTS.md inheritance for worker subagents (jintong, guangguang, yunu); code review is an orchestrator-owned code-quality gate, while taishang remains architecture/debugging/plan-compliance only |
| `src/prompts.ts` | Doc comment lists three modes; builder output for `system_instructions` is identical to `replace` (the branch lives in `agent-runner.ts`) | Mode behavior orthogonal to prompt assembly |
| `src/agent-definition-authoring.ts` | Frontmatter template + guidelines describe `system_instructions` mode | User-visible authoring docs |
| `src/agent-runner.ts`, `src/agent-manager.ts`, `src/index.ts`, `test/agent-runner.test.ts`, `test/index.session-context.test.ts` | Subagent sessions use parent-scoped `~/.pi/agent/subagent-sessions/<parent-session-id>/` and persist `sessionFile`/`sessionDir`/parent metadata in records/events | Keeps main `/tree` session list clean while preserving subagent log discoverability |
| `src/agent-run.ts` | Local-only file | C/D revamp keystone: single-source `AgentRun` event-stream reducer, `waitForTerminal`, supervision snapshots, pure `toExternalEffects` two-bus mapping |
| `src/external-contract-adapter.ts` | Local-only file | Owns terminal `subagents:record` compatibility plus completed/failed effects via `toExternalEffects`; `buildSubagentRecordEntry` is the durable field set |
| `src/agent-manager.ts`, `src/agent-run.ts`, `src/tools/agent.ts`, `test/{agent-manager,agent-run}.test.ts` | AgentRun lifecycle publication plus store-backed fresh/resume begin and terminal barriers; failed terminal commits retain the terminal candidate and block provider re-entry until repair | Keeps runtime effects behind durable metadata without changing public invocation/status unions or external event names |
| `src/lifecycle/supervision.ts` | Terminal emission via `emitTerminalContract`; foreground-wait loop reuses `getBackgroundSupervisionAction`; supervision activity resolves `AgentRun` first with legacy map fallback | Two-bus boundary + supervision de-dup across direct/RPC spawn paths |
| `src/background-supervision.ts` | `ignoreWaiters` flag on `getBackgroundSupervisionAction` | Lets the foreground supervised-wait reuse one decision fn |
| `src/tools/agent.ts` | `runActivityView(run)` backs direct-Agent `agentActivity` entries (getters + `nonStreamingSince` setter) | Widget/get_result read the single source; legacy no-run records remain compatible |
| `test/regression/{agent-run-parity,lifecycle-contract,external-contract-adapter,run-activity-view,supervision-ignore-waiters,agent-end-notification}.test.ts`, `test/agent-run.test.ts` | New characterization + parity tests | Lock C/D revamp behavior + frozen contract + agent_end notification |
| `src/{agent-run.ts,external-contract-adapter.ts,cross-extension-rpc.ts,lifecycle/{supervision,durable-delivery,agent-lifecycle-store}.ts,tools/{agent,get_subagent_result}.ts}`, `test/{agent-run,subagent-integration}.test.ts`, `test/regression/{external-contract-adapter,terminal-contract-parity}.test.ts` | Store-backed `consumed`/`notified` delivery; terminal order `V1 → subagents:record → advisory event`; compatibility-only repair; consolidated idle notification order `sendMessage → markNotified` with documented at-least-once duplicate window | Prevents false consume acknowledgements, prevents success listeners from beating durable history, preserves background-only public events, and keeps send outside the store queue. |
| `src/lifecycle/supervision.ts`, `src/lifecycle/cleanup.ts`, `test/index.session-context.test.ts` | RPC-only spawns activate the Agents widget immediately, queued → running transitions refresh it, and shutdown disposes it. | Keeps widget activation owned by subagent runtime without rebinding session UI context or coupling caller internals. |
| `src/types.ts`, `src/lifecycle/registry-persistence.ts`, `test/{bg-agent-registry-replay,task-claim-write-through}.test.ts` | Added versioned `subagents:resume-target-v1` persistence with generation/revision LWW replay, validated compatibility snapshots, serialized guarded writes, and immutable write-failure behavior | Preserves lightweight restoration lookup metadata after live child cleanup without changing existing registry, task-claim, RPC, or event contracts. |
| `src/{agent-manager.ts,lifecycle/{agent-lifecycle-store,compaction-checkpoint,registry-persistence,supervision}.ts,ui-wiring/messages.ts}`, `test/{agent-manager,compaction-survival,bg-agent-registry-replay}.test.ts` | Successful child compactions checkpoint exact child JSONL bytes under captured generation leases; parent pre-compaction waits only on store barriers with abort/5s cancellation; post-compaction replay re-emits exact current V1 snapshots | Prevents stale callbacks and compaction races from losing or inventing durable resume state without waiting on provider/listener/advisory work |
| `src/session-restoration.ts`, `src/agent-runner.ts`, `src/tools/agent.ts`, `test/{session-restoration,agent-runner,index.session-context}.test.ts`, root restoration integration | Raw-prefix SHA-256 authentication, direct-suffix validation, phased unbound/open bind reconciliation, canonical validated target capture, and fresh-target capture of Pi's concrete post-default/post-clamp thinking level | Restores the same durable child across late title and trusted bind metadata while failing closed on tamper, branching, interrupted work, thinking-level drift, or manager/file divergence |
| `src/{agent-runner,agent-manager,tools/agent}.ts`, `test/{agent-manager,index.session-context}.test.ts`, `test/regression/{finalize-run-parity,result-recovery-no-double-abort}.test.ts`, root restoration integration | Pi 0.79 pre-prompt JSONL flush, post-barrier started emission, authenticated pending-terminal repair, truthful persistence failure, idempotent stop recovery, and deterministic restored-resume/child-compaction/terminal race coverage | Proves `g+1/r0 → r1 checkpoint → r2 terminal`, truthful `persistence_failed`, retained fresh output, and zero duplicate provider/tool execution through the real runtime |
| `src/{session-restoration,types,agent-run,agent-manager,tools/agent}.ts`, `src/lifecycle/{agent-lifecycle-store,compaction-checkpoint,running-reconciliation}.ts`, `src/ui/{summary-renderer,agent-widget}.ts`, restoration/lifecycle/UI tests | Active-branch recovery boundaries plus V1 `completionDisposition` (`clean`/`recovered`) | Allows only explicit user-bounded recovery from historical `error`/`aborted` turns, preserves recovered dominance through replay/checkpoint/delivery/resume, never replays historical tools, and renders recovered non-error records as resumable warnings rather than failures |
| `src/settings.ts`, `src/runtime-flags.ts` | Added `toolDescriptionMode` (`full`/`compact`) + `scopeModels` settings, module-level runtime flags | Ported upstream toolDescriptionMode (#0.10.2) + scopeModels (#0.9.0) in fork vocabulary |
| `src/agent-tool-description.ts`, `test/agent-tool-description.test.ts` | Local full/compact tool descriptions; accurately define `run_in_background` as result-delivery behavior, while concurrently dispatched foreground or background calls may overlap | Keeps compact mode ≈75% smaller without misrepresenting foreground execution as globally serialized |
| `src/enabled-models.ts` | Ported from upstream + local `decideModelScope` | scopeModels guardrail; caller-param out-of-scope blocks, frontmatter/inherited warns (frontmatter authoritative) |
| `src/ui/conversation-viewer.ts` | `stopArmed` + `onStop` two-press `x` confirm | Stop agent from viewer (#0.10.0); aborts via `AgentManager.abort` → AgentRun pipeline (no new emission) |
| `src/agent-runner.ts` | `extensionCanonicalName` + `buildExtensionsOverride` + `extensionsOverride` wiring | Revives dead `extensions: string[]` allowlist + adds `exclude_extensions` denylist (T2.3 Stage 1); `computeActiveToolNames` stays denylist-free |
| `src/tools/{agent,get_subagent_result,steer_subagent}.ts`, `test/agent-tool-renderer.test.ts` | All three Subagent tools have width-safe custom TUI render pairs; `Agent` calls summarize only explicitly supplied per-call `skills`, while expanded results preserve their complete input order and duplicates; steering distinguishes delivered, queued, rejected, missing-target, failed, and raw-fallback outcomes | Prevent duplicate/noisy/misleading history output while preserving model-visible content; skill presentation intentionally does not inspect or infer agent frontmatter/preload config |
| `src/local-uri-hint.ts`, `src/tools/{agent,steer_subagent}.ts`, `test/local-uri-hint.test.ts` | `localUriHint(...sources)` appends a non-blocking heads-up to Agent (spawn/resume) results and `steer_subagent` results when the caller's `prompt`/`message` contains `local://`. | `local://` storage is per-session, so a parent's files are invisible to the subagent's session; catches the mistake at delegation time instead of only reactively when the child's `read local://` fails. Legit `local://` writes are not blocked. |
| `src/agent-run.ts`, `src/tools/get_subagent_result.ts`, `src/lifecycle/supervision.ts`, `test/index.session-context.test.ts` | `wait: true` follows queued → running → terminal through cancellable per-poll `AgentRun` subscriptions; waiter count stays AgentRun-owned | Ports upstream queued-wait fix (#0.14.0/#127) without introducing a queued `record.promise`, accumulating terminal waiters, or bypassing local supervision/abort handling |
| `src/output-file.ts`, `test/output-file.test.ts` | Transcript stream flushes before compaction and re-anchors after successful compaction settles | Ports upstream compaction-stream fix (#0.14.0/#145) while preserving local JSONL format and write-error tolerance |
| `src/agent-runner.ts`, `src/agent-manager.ts`, `src/tools/agent.ts`, `test/{agent-runner,agent-manager,agent-tool-renderer}.test.ts` | Fresh final assistant `error` and empty `length` stops become AgentRun failures; real partial output remains labeled while synthesized recovery diagnostics remain unlabeled | Ports upstream final-turn failure fix (#0.14.1/#144) through local sole-writer/error-rendering contracts; abort/stop precedence remains local |
| `src/ui/conversation-viewer.ts`, `src/ui/conversation-viewer.test.ts` | Bordered rows use width-aware padded truncation across CJK/wide-glyph boundaries | Ports upstream exact-width viewer fix (#0.14.2/#153) without changing viewer layout or controls |
| `extensions/lib/agent-frontmatter.ts`, `src/types.ts`, `src/agent-types.ts`, `src/custom-agents.ts`, `src/agent-runner.ts`, `src/agent-definition-authoring.ts`, `test/{custom-agents,agent-types,agent-runner,prompts,invocation-config,index.agents-menu,agent-tool-renderer}.test.ts` | Split tri-state `skills` frontmatter into orthogonal `discover_skills` (boolean, default true → runtime `noSkills = !discover_skills`) + `preload_skills` (CSV names → `preloadSkills()`/`extras.skillBlocks`); legacy `skills`/`inherit_skills` are now loud invalid fields | Independent catalog-vs-preload control; enables the previously-impossible discover+preload combo (catalog on while eagerly injecting skills) |
| `src/tools/agent.ts`, `src/agent-manager.ts`, `src/agent-runner.ts`, `src/agent-tool-description.ts` | Per-call `skills` inject param on `Agent` tool: union with frontmatter `preload_skills` (frontmatter-first, Set-deduped), fresh-spawn only, ignored when `isolated: true`; renderer presentation remains the unmodified per-call input, independent of execution-time resolution | Orchestrator injects skills into skill-less subagents (OMO `load_skills` model); subagents have `discover_skills: false` so the only way to give them skill content is eager injection |

| `package.json` | `peerDependencies` for pi packages (+typebox) use pnpm `catalog:` | Versions centralized in root `pnpm-workspace.yaml` `catalog:`. Re-apply after upstream sync (upstream ships literal ranges). |
## Child DOX Index

No child `AGENTS.md` files. This file owns all files under `extensions/subagent/`.
