# Workflow Presentation Implementation Plan

Status: shipped

Scope authority: [Workflow Tool and Notification Presentation](../specs/workflow-tool-output-presentation.md). Every requirement and mockup there remains required; this plan does not narrow it.

## 1. Lock the public behavior

Use `extensions/subagents/test/workflow-registration.test.ts` to exercise the registered SubagentWorkflow tool and actual notification renderer from the same completed run. Extend `workflow-presentation.test.ts` for native terminal width/entry serialization and `notification-rendering.test.ts` for ordinary Agent and malformed payload compatibility only where coverage is missing.

Write red tests before production changes:

- A returned `{ research, review }` never collapses to `{`; the first active task label and `agentType` appear together, other running tasks are counted, and all child identities survive terminal expansion.
- Full notification results survive beyond the ~500-character model-facing preview cap through a linked `<result-file>` artifact, including truncation markers, artifact path and artifact-write error.
- Terminal empty output never becomes stale progress text; object/array/null/string shapes render honestly.
- State/count fixtures distinguish execution lifecycle, explicit succeeded/partial/failed outcomes, the default `Completed` for undeclared outcomes, and failed/skipped/blocked/interrupted/replayed children.
- Collapsed tool results and standalone notifications have at most three physical rows across the width matrix; full retained output and appendix survive expansion/serialization.
- Completion model content intentionally gains outcome/execution/settlement disclosure. Preserve payloads, `isError`, notification timing/channel/one-owner delivery, usage, permissions, replay/resume, and generic Agent notification behavior.
- Required `agent()` failure rejects; `{optional:true}` permits null only for ordinary terminal failures. Policy/configuration/programming/fatal errors reject. User skips remain null. Thrown orchestration rejects; pipeline null short-circuits later item stages, unlike false/0/empty strings.
- Explicit `outcome.succeed/partial/fail` preserves omitted/falsy payloads and nested envelopes; arbitrary payload fields never imply outcome. Malformed envelopes fail execution; malformed persisted data retains raw fallback.

## 2. Carry execution and declared-outcome facts

Affected seams:

- `src/workflow/runtime.ts`, `worker-source.ts`, `host.ts`, and `outcome.ts`: required/optional failure classification, null-only pipeline short-circuiting, frozen explicit outcome helpers, and root normalization. Keep execution status independent from objective outcome; preserve gate diagnostics, retry usage, keys, replay, and permissions.
- `src/workflow/task.ts`: retain optional declared outcome and payload separately; model-facing notification text discloses `Outcome ...`, `Execution: ...`, and completed/failed/skipped child counts. Artifact fields remain set solely by the existing writer.
- `src/workflow/entry.ts` and `entry-validation.ts`: carry outcome, retained value/progress, identity, and artifact facts in plain snapshots. Legacy records without outcome remain valid; malformed data falls back to raw content.
- Existing workflow notification details and `src/index.ts` keep the complete serializable snapshot, immediate acknowledgement, missing-live-state fallback, artifact writes/thresholds, and delivery timing/channel.
- Bundled workflows declare acceptance/rejection explicitly; only intentional recovery or optional gaps use optional calls. The authoring skill teaches bounded repair, null versus falsy, replay, and nested outcome propagation.

## 3. Implement one workflow report path

Keep existing progress ownership in `src/workflow/progress.ts`; reuse `collapse`, `displayState`, and phase grouping instead of reparsing logs. Do not alter their execution semantics.

Update `src/ui/workflow-card.ts` and, if needed to keep responsibilities bounded, add a focused `src/ui/workflow-report.ts` for the shared report rendering. Keep inspector-facing styling/format utilities compatible. `src/notification-rendering.ts` dispatches only valid workflow payloads to that report path; generic notification behavior stays unchanged.

Presentation decisions:

- Call header: one width-safe `SubagentWorkflow · <name>` line; configured source-name fallback retained.
- Tool collapsed: `Outcome ...` for completed execution or execution failure/activity; `Execution: completed` and observed child counts; configured hint and inspector route. No tools/tokens/duration metadata.
- Notification collapsed: `Workflow outcome ... · <name>` on normal return, `Workflow execution failed` on uncaught failure. Child settlement remains separate; execution failure takes precedence over declared outcome.
- Successful strings use meaningful returned text. Objects use `structured result` plus field names; arrays expose item count. Null is a returned JSON scalar; absent/empty output is explicit. Do not adopt a `summary` field convention or make model calls.
- Expanded tool: state-specific Activity/Result/Error; phase-grouped complete roster; Run; actual Artifacts; inspector route; retained child details/logs in a separate appendix.
- Expanded notification: outcome; full retained Result/Error; compact complete roster; Run; existing full-result path; artifact errors. Keep retained detail appendix if the payload includes evidence otherwise lost.
- Strings use readable Markdown, JSON uses safely fenced/formatted text. Expanded values/paths wrap without semantic clipping. No display cap is needed for the retained workflow return; do not create new files to impose one.
- Keep effective model/thinking and existing prompt/result/error previews and logs in a separated appendix; preserve old retention tests. Cached work is visibly replayed. Unknown Subagent type stays absent.
- All user-controlled single-row fields flatten CR/LF, fit terminal-cell width, and obey the three-row budget. Extremely narrow views preserve status/error ahead of metadata. Use semantic theme roles and the configured expand binding.
- Valid legacy plain returns default to `Completed`; malformed snapshots use raw fallback. Notifications retain complete snapshots after live tasks disappear; tool rows without live tasks retain the acknowledgement fallback rather than inventing durable recovery.
- Inspector: replace phase drill-down/filtering with one stable phase-grouped roster keyed by workflow entry index. Show effective `modelId` only; unresolved sessions say `model pending`. Wide layouts pair roster with state-first detail, narrow layouts use explicit detail/back navigation, and controls appear only when valid.

## 4. Check implementation and docs

Run in the already-loaded project direnv environment:

1. `pnpm exec vitest run --project unit extensions/subagents/test`
2. `pnpm --dir extensions/subagents typecheck`
3. Focused Biome checks on changed TypeScript files, without broad baseline formatting churn.
4. Programming skill TypeScript no-excuse audit on changed source/tests; distinguish pre-existing findings from new ones and remove introduced violations.
5. `git diff --check` and inspect the actual diff against spec and unrelated worktree changes.

Update nearest owning `extensions/subagents/AGENTS.md` and README with the workflow-only contract, link the new spec from docs index, and keep parent ownership/index rules accurate. No changes to generic Agent semantics, original provenance, or unrelated docs.

## 5. Verify in real Pi through interactive_shell

The user explicitly authorized fresh Pi verification with real workflow children. The parent orchestrator owns capture and visual assessment; implementation workers do not claim it passed.

- Launch a fresh interactive Pi session through interactive_shell, loading the worktree extension. Use isolated temporary session/output artifacts, not a persistent host install or edits to user configuration.
- Have the model generate and execute a small task-specific workflow with two or more real child labels/types and a structured `{ research, review }` return. Keep work read-only; request a long retained result with a tail marker so notification expansion is exercised beyond 500/4000 characters.
- Capture running collapsed state while children are active, then completed collapsed tool and notification output.
- Toggle the actual configured expand action and capture full-result content, identity roster, Run/artifacts, and retained details. Inspect `/agents → Workflows` and child ordering/conversation availability.
- Exercise explicit domain failure after successful child execution and required gate failure that suppresses dependent work. Capture collapsed and expanded states with reason, execution, and child counts; unit tests cover artifact-write failure without breaking user storage.
- Use terminal captures/interactive-shell output to assess hierarchy, colors where observable, width, and real keybinding integration. Keep screenshots only when they add evidence; use look_at for image assessment.
- Inspect session/journal/result artifacts using pi-jsonl-logs skill. Verify children actually executed, completion count/status, one notification, and full result retention. A UI screenshot alone does not prove execution.
- Close every temporary Pi/tmux/interactive-shell process. Leave no background verification sessions running.

## Completion audit

Before marking the spec shipped, record concrete evidence for each group:

| Requirement | Required evidence |
|---|---|
| All exact accepted formats and distinctions | Spec/mockup-to-render diff review plus public render tests |
| Structured result and lasting label/type identity | Recorded regression fixture, registered renderer checks, real Pi captures |
| Complete notification return and truthful artifacts | Long-tail test, artifact success/failure tests, real session details/result |
| Execution, objective outcome, and child settlement | Required/optional and null/falsy fixture tests; independent outcome/execution rendering; replay/usage regressions |
| Width and hints | Native Unicode/ANSI width matrix and real expand-key capture |
| Inspector roster and active model | Pure layout/key tests, effective-model transition fixture, Pi API audit, and real `/agents → Workflows` capture |
| Retained details and historical fallback | Entry/notification serialization tests and appendix markers |
| Preserved contracts and intentional changes | Outcome/execution/settlement message assertions; unchanged payload, delivery, usage, permissions, and replay mechanics; source diff |
| Implementation quality | Typecheck, targeted lint/static audit, diff check |
| Documentation and cleanup | Owning DOX/index pass and no live verification processes |

## Verification record

### 2026-09-16 failure/outcome amendment

Parent-reported completion evidence for the shipped amendment:

- Focused runtime/host/outcome/reporting/skill/saved-workflow verification: **11 files, 270 tests passed**.
- Final combined unit suite: **191 files, 2864 tests passed**.
- Root and extension typechecks, production LSP diagnostics, and `git diff --check`: passed.
- Fresh Pi explicit domain-failure QA: passed; execution completion and declared failure are distinguished. Parent owns terminal/session evidence.
- Fresh Pi required gate-failure QA: passed in session `01a0aafc-8e74-755c-9834-412fb4f7cbf9`, run `wf_0362e37bbaaf`. Gate `false` produced execution failure, the notification reported `0/1 agents completed, 1 failed, 0 skipped`, and retained progress contained only the `required` label; the dependent call never launched.

The amendment intentionally changes required/optional execution failure handling and model-facing notification disclosure. Delivery timing/channel, usage, permissions, replay/resume, and retained-result requirements remain preserved. Monitor/inspector redesign is outside this amendment.

### 2026-09-16 workflow monitor redesign

- Independent UI/API audit confirmed Pi 0.85.1 custom overlay lifecycle, width/height inputs, key handling, focus restoration, optional mouse support, and disposal requirements. The implementation uses only supported component/custom-overlay APIs.
- `workflow-dialog.test.ts` covers stable phase grouping and selection, effective-model versus pending/not-run states, all lifecycle distinctions, paused scheduling copy, wide/narrow navigation, state-first detail, contextual controls, width safety, timer settlement/disposal, and conversation-overlay restoration.
- Focused presentation tests: **29 passed**. Full extension suite after integration: **59 files, 1131 tests passed**. Combined parent suite: **191 files, 2864 tests passed**. Root and extension typechecks and changed-file LSP diagnostics passed.
- Fresh Pi session `workflow-monitor-qa` executed `monitor-qa` read-only with declared Research/Verify phases and two real children. `/agents → Workflows` displayed one stable roster, explicit Completed states, active models `gpt-5.6-luna` and `gpt-5.6-terra`, state-first outcome/prompt/runtime detail, and conversation navigation; completion reported 2/2 agents and no file changes.
- Biome remains unavailable for these files because the repository currently exposes conflicting root and nested-root Biome configurations; targeted invocation exits before processing files. This is an existing tooling condition, not a suppressed diagnostic.

### 2026-09-14 presentation baseline (historical)

The following evidence records the original presentation-only implementation. Its unchanged-execution/model-byte claims and old completed-with-child-errors labels apply to that baseline, not the amended failure/outcome contract.

#### Automated and source evidence

- `pnpm exec vitest run --project unit extensions/subagents/test`: **56 files, 1058 tests passed**. The registered report tests now live in `workflow-report-registration.test.ts`, sharing `workflow-registration.fixture.ts` with the original registration/runtime suite.
- `pnpm --dir extensions/subagents typecheck`: passed.
- Snapshot regression covers JSON-serializable object returns, including dates and function-valued properties: snapshots use the existing JSON representation rather than imposing structured-clone restrictions. Retained progress entries are copied independently of the live array.
- Biome 2.4.10 checked all 14 changed TypeScript files with repository rules and a temporary include override (the root config excludes this vendored subtree): no errors; two existing private-member test-access informational findings remain unchanged. Formatting is disabled by repository policy.
- Programming audit: no violations in 13 changed files. The existing `src/index.ts` has the same 15 baseline findings as HEAD; normalized diagnostics match exactly. No new suppression or type escape was introduced.
- `git diff --check`: passed. Shared report and artifact-writer modules replace the old embedded implementations; execution, model-content formatting, artifact threshold/writes, and notification scheduling remain unchanged. New report/fixture modules are below 250 code lines.

| Accepted scope | Evidence |
|---|---|
| Structural summaries, four-child identity regression, active label/type and concurrent count | Registered report tests; real structured and running captures |
| Complete notification strings beyond the ~500-character preview cap, actual result path and write failure | Registered long-tail and artifact-failure tests; serialized real notification and result artifact |
| Running/queued/paused/stopped/failed/completed, child errors, skipped/blocked/interrupted/replayed | Native presentation state tests; real running, child-error and script-failure captures |
| Result-first reports, phase rosters, retained prompts/results/model/thinking/logs | Registered ordering assertions and serialized native report tests; expanded captures and inspector/conversation |
| Widths 0/1/2/8/20/40/80/120, Unicode/ANSI/Markdown/JSON/paths and configured hint | Native width matrix, including serialized standalone reports; actual Ctrl+O captures |
| Model bytes, error handling, one follow-up, generic Agent compatibility, historical fallback | Registration/delivery and generic notification tests; three real runs with exactly three completion messages; reload capture |
| Truthful artifacts after a zero-child failure | Regression rejects reserved-but-unwritten journal paths; final reloaded report advertises only the saved script |

#### Real Pi evidence

A fresh Pi 0.85.1 session was launched through `interactive_shell` inside a dedicated tmux server, loading the worktree extension. The model authored and invoked all three inline scripts; children were read-only.

- Session: `/tmp/workflow-presentation-qa-session.jsonl`, ID `01a09e9b-d889-73b7-918e-091538595dc0`.
- `wf_59028e5780b3`: two successful parallel children, `research-readme / chengfeng` then `review-package / guangguang`, grouped under Research/Review. Journal indices 0/1 are successful with 499/276-character nonempty results. The returned object contains `research`, `review`, and a long `padding` field. `QA-RETAINED-TAIL` survives the notification snapshot and saved result while remaining absent from the bounded model message.
- `wf_b878e62f9a52`: one real child followed by an authorized delayed, exit-7 gate. Captured `Running · 1 active` with `controlled-check · chengfeng`; completion is explicitly **completed with agent errors**, with one failed journal entry and `QA-CONTROLLED-GATE-FAILURE` diagnostics.
- `wf_7187322cff9c`: intentional zero-child script failure. Captured explicit **Failed**, `QA-SCRIPT-FAILURE`, and error-first expansion. The final post-reload capture contains no link to its unwritten journal.
- Inspected `/agents → Workflows`, both phase entries, and the first child's actual conversation. Reload shows unavailable live state honestly while serialized notification reports retain their results.
- Session overview/tool/custom-message scripts confirmed three workflow calls and exactly three completion notifications. Journal and result-file checks establish execution/retention, not merely the model's completion claims.

Terminal captures (plain rendered terminal text):

- `/tmp/workflow-qa-structured-collapsed.txt`
- `/tmp/workflow-qa-structured-expanded.txt`
- `/tmp/workflow-qa-running-collapsed.txt`
- `/tmp/workflow-qa-child-error-collapsed.txt`
- `/tmp/workflow-qa-child-error-expanded.txt`
- `/tmp/workflow-qa-script-failure-collapsed.txt`
- `/tmp/workflow-qa-script-failure-expanded.txt`
- `/tmp/workflow-qa-inspector.txt`
- `/tmp/workflow-qa-conversation.txt`
- `/tmp/workflow-qa-reloaded.txt`
- `/tmp/workflow-qa-final-expanded.txt` — final renderer after the artifact-route correction.

Captures and session artifacts are ephemeral evidence, not a new retention guarantee. The owning subagents AGENTS/README and documentation indexes were updated. Root and extension-parent ownership contracts were intentionally unchanged; this feature adds no ownership boundary. Unrelated worktree changes were preserved.

Cleanup completed: Pi exited normally with code 0 after Ctrl+D; the interactive-shell session was closed, and the dedicated tmux socket reported no running server. No QA child, Pi, tmux, or overlay process was left running.
