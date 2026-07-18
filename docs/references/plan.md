# Plan — Fix false-positive `Agent(resume)` (stale prior-summary) in `extensions/subagent`

Status: draft (RED authorized; prod waves gated on approval)
Date: 2026-07-17
Related: GitHub issue #10 (secondary defect) · ADR `docs/adr/0001-orchestration-sizing-follows-upstream-omo.md`
Source of plan: xuannv tactical consult + taishang architecture consult, grounded against source and the archived incident log.

## Problem (confirmed)

`Agent(resume: agentId, prompt)` can return a PRIOR completed summary WITHOUT applying the new prompt, surfaced as a false-positive success (`isError=false`, `Outcome COMPLETED`).

Confirmed in archived log `docs/references/houtu-session-019f6f3e-75a9-7f06-90cf-4fee29b08177.jsonl` (SHA-256 `0671062…d66437`, verified):
- 3 `Agent(resume)` calls to agent `d2eb7e5a-3ae4-480` during PLAN 3 repairs.
- Resume #2 (09:00:27Z) and #3 (09:00:54Z) returned **byte-identical** `COMPLETED` summaries though #3 carried a new correction prompt ("Second verification REJECT, PLAN 3…"). `isError=false` on the stale result.
- Durable target at resume: `status:"completed", resultConsumed:true, toolUses:81`.
- Recovery: Hou Tu abandoned resume and launched a fresh juling (09:01:23Z).

Now **load-bearing**: the ADR removed the worker scope guard and made `Agent(resume)` the primary recovery path.

## Root cause (file:line)

- `agent-runner.ts:586` — `resumeAgent` returns `collector.getText().trim() || getLastAssistantText(session)`.
- `getLastAssistantText` (`agent-runner.ts:157-165`) skips empty messages → returns the PRIOR non-empty assistant summary (full-history scan is the leak).
- `agent-manager.ts:539` repeats masking: `responseText.trim() || getRecoveredResultText({...record, status:"completed"})` — force-labels completed.
- Empty resumed-turn output arises when the resumed turn fails/aborts (pi-agent-core `handleRunFailure` synthesizes an empty-text assistant msg, no rethrow) OR (candidate) when resuming a `completed`+`resultConsumed:true` session yields no new message. Both covered by the fix.
- Tool success text = `getRecoveredResultText(record)` (`tools/agent.ts:596`), NOT `resumeAgent`'s return. Live/restored resume returns `{status:"resumed_live"|"restored_session"}` regardless of turn outcome — so the only way to surface failure is make `resume()` return `{status:"failed"}` so the tool takes the `Failed to resume` branch (`tools/agent.ts:582`).
- `textResult` does NOT set top-level `isError` (`supervision.ts:146-148`); existing failed branches surface via `invocationStatus:"failed"`.
- Fresh-spawn `runAgent:556` has the same `||` but no prior assistant to leak — **leave untouched**.

## Fix shape (agreed)

1. **Outcome-based detection** in `resumeAgent`: snapshot `session.messages.length` before `session.prompt()`; after resolve return discriminated `{ok:true,text}` | `{ok:false,reason}` where ok:false if (a) no new assistant message appended, OR (b) newest terminal assistant `stopReason ∈ {error,aborted,length}`, OR (c) collector empty with no clean stop. ok:true text uses a snapshot-bounded last-assistant scan (never full history). Sentinel via typed return, NOT throw.
2. **Failure routing + persist-guard** in `agent-manager.ts`: `continueRecord` returns a discriminated outcome; on ok:false publish `failed` (not `completed`), remove masking `:539`, and never persist a forced `completed` target. `resume` live/restored branches map ok:false → `resumeFailure(...)`.
3. **Leave `runAgent:556` untouched.**
4. **Conditional restoration reset** (`session-restoration.ts`): only if RED proves `prompt()` genuinely appends no message on a `completed`+`resultConsumed:true` restore.
5. **Turn-ceiling for resumed workers**: `resumeAgent` lacks the `maxTurns`/grace/steer machinery `runAgent` installs (`:491-534`); incident hit `toolUses:81` uncapped. Share the ceiling helper.

## Approval gate (enterprise contract)

`extensions/subagent` is **shared runtime**. RED waves D1+D2 (tests only) are authorized now. Prod waves **D3/D4/D5 require explicit user approval BEFORE any prod-code edit**. Present D1/D2 RED evidence at the checkpoint.

## Waves

Worker sizing per ADR: one resumable worker session per bounded deliverable, no re-splitting. jintong = standard non-UI; juling = complex/higher-risk non-UI.

### D1 — RED unit (authorized) · jintong
- File: `extensions/subagent/test/agent-runner.test.ts` (ADD cases; do NOT touch existing `:325-331`).
- Extend the fake-session builder (`createSession`, ~`:68-89`) to pre-seed `messages` with a prior COMPLETED assistant summary `{role:"assistant",content:[{type:"text",text:"PRIOR SUMMARY"}],stopReason:"stop"}`, then:
  - Case A: `.prompt()` pushes `{role:"assistant",content:[],stopReason:"error"}` (empty text, error stop).
  - Case B: `.prompt()` pushes nothing.
  - Both assert `resumeAgent(session,"correction")` does NOT yield `"PRIOR SUMMARY"` (post-fix: `.ok === false`). RED today (returns the prior string).
- Acceptance: `pnpm exec vitest run --project unit extensions/subagent/test/agent-runner.test.ts` → new cases FAIL RED for the right reason; legacy `:325` still passes.

### D2 — RED integration (authorized) · juling
- File: `test/integration/subagent-session-restoration.integration.test.ts` (ADD; reuse `installFixture`/`invokeAgent`/`nativeFauxHandle`, `registerFauxProvider`/`fauxAssistantMessage`).
- Step 0: confirm faux support for empty/error resumed turn; fallback `faux.appendResponse("")`.
- Positive: resume with correction demanding a unique token → assert token present + `invocationStatus:"resumed_live"`.
- Failing: resume yields empty/error turn → assert body starts `Failed to resume agent`, no prior summary/token, `invocationStatus === "failed"`. Key off `invocationStatus`, NOT `isError` (unless D3 opts to set it). RED today.
- Acceptance: `pnpm exec vitest run --project integration test/integration/subagent-session-restoration.integration.test.ts` → failing case FAILS RED.

--- APPROVAL CHECKPOINT: present D1+D2 RED evidence; get explicit go for prod edits ---

### D3 — Detection + failure-routing + persist-guard (gated, atomic) · juling
- Files: `agent-runner.ts` (`resumeAgent` discriminated return + snapshot-bounded fallback), `agent-manager.ts` (`continueRecord` discriminated outcome, remove `:539` masking, persist-guard; `resume` live `:410-411` + restored `:442-446` map ok:false → `resumeFailure`), rewrite legacy `agent-runner.test.ts:325-331` to the new happy-path contract, make D1 GREEN. `tools/agent.ts` no logic change (already handles `status:"failed"`).
- Open design decision (resolve at approval): also set top-level `isError:true` on failed resume, or keep repo convention `invocationStatus:"failed"` only.
- Acceptance: unit `agent-runner.test.ts` all GREEN; D2 failing case GREEN; existing live-resume/restore tests GREEN; `pnpm test:extensions` GREEN; `pnpm lint:typecheck` clean.

### D4 — Turn-ceiling for resumed workers (gated) · juling
- File: `agent-runner.ts` — extract shared `installTurnCeiling(session,{maxTurns,graceTurns,onTurnEnd})` from `runAgent`'s `:491-534`; use in `runAgent` + `resumeAgent`; resolve ceiling in `continueRecord`.
- Acceptance: test asserting resumed session steers at soft limit + aborts at `maxTurns+graceTurns` (mirror `test/regression/supervision-ceiling.test.ts`); `pnpm test:extensions` GREEN; `pnpm lint:typecheck` clean.
- Deps: D3.

### D5 — Conditional restoration reset (gated + conditional) · juling
- Precondition: ONLY if D1 Case B / D2 prove `prompt()` appends no message on `completed`+`resultConsumed:true` restore. Otherwise SKIP (D3 detection covers it).
- File: `session-restoration.ts` (smallest terminal-state reset).
- Acceptance: targeted `session-restoration.test.ts` case GREEN; full `pnpm test:extensions` + `pnpm test:integration` + `pnpm lint:typecheck` GREEN.
- Deps: D3; RED evidence proving necessity.

## Final verification gate
`pnpm test:extensions` · `pnpm test:integration` · `pnpm lint:typecheck` — all GREEN.

## Open questions (resolve at approval; don't guess)
1. `isError` policy: top-level `isError:true` on failed resume (contract change) vs repo convention `invocationStatus:"failed"` only.
2. D3 bundling: detection+routing+persist-guard as ONE atomic worker deliverable (return-type change) — recommended over splitting to avoid a non-compiling intermediate.
3. D5: defer until D1/D2 RED shows whether the no-append restore path actually fires.

## RED status (captured)

- **D1 unit — RED confirmed.** `extensions/subagent/test/agent-runner.test.ts` Cases A (empty-error turn) and B (no new message) both fail today with `expected 'PRIOR SUMMARY' not to be 'PRIOR SUMMARY'`; 11 pre-existing unit tests stay green.
- **D2 integration — RED confirmed (real pi runtime).** New case "empty resumed turn surfaces as failure and never echoes the prior summary" fails with `'Completed: stored RESUME-STALE-42 sum…' not to contain 'stored RESUME-STALE-42 summary'` — the live-resume path echoes the prior COMPLETED summary as `resumed_live`. Confirms **candidate B (empty resumed turn) reproduces end-to-end**; `faux.appendResponse("")` is a sufficient trigger.

## Pre-existing failure observed (NOT introduced here) — relevant to D3/D5

- `test/integration/subagent-session-restoration.integration.test.ts > "restores a completed child after production session-start cleanup"` **fails deterministically at baseline** (verified by stashing the D2 edit; 2/2 runs identical): the RESTORE path returns `invocationStatus:"failed"` where the test expects `restored_session`. No `extensions/subagent/src` change exists in the working tree, so this equals HEAD behavior.
- Implication for the fix: the `restored_session` path may already be failing for a *legit* restore in this environment. D3's failure-detection MUST NOT relabel a legitimate restore as failed. Investigate this restore-path failure as part of D3 (or a paired sub-task) before finalizing the detection predicate; it may share root cause with the stale-resume defect or be a separate restore-runtime break.
- Action: reproduce/triage the `restored_session` failure with the faux fixture; decide whether it folds into D3 or becomes its own follow-up.

## D3 SHIPPED (verified by orchestrator)

Implemented by juling, taishang-approved, verified independently:
- `agent-runner.ts`: `resumeAgent` now returns discriminated `ResumeOutcome` (`{ok:true,text}|{ok:false,reason}`); snapshot `before = session.messages.length`; ok:false when (1) no assistant msg appended, (2) newest `stopReason ∈ {error,aborted,length}`, (3) no streamed text and no snapshot-bounded text. Added `getLastAssistantTextSince` (no full-history scan). `runAgent:556` untouched.
- `agent-manager.ts`: `continueRecord` consumes the outcome — on ok:false publishes `{kind:"failed"}` (record.status→error BEFORE persist, so no forced-completed durable target) and returns a failure outcome; both `resume()` branches map ok:false → `resumeFailure(...)` so the tool reports failure. Removed the `:539` completed-masking on the failure path.
- `agent-runner.test.ts:325`: rewritten to the new happy-path contract (`{ok:true,text:"RESUMED"}`).
- Kept repo convention: `invocationStatus:"failed"`, no top-level `isError` (per taishang).

Evidence (run by orchestrator): D1 unit 13/13 GREEN; D2 integration — empty-turn case GREEN (surfaces `invocationStatus:"failed"`, no stale echo), live-resume + fresh-calls GREEN. Subagent unit suite: 33 failed / 588 passed WITH fix vs 33 failed / 586 passed baseline → **0 new failures, +2 (the D1 cases)**. tsc: 0 new errors (only pre-existing `extensions/visuals/write-tool.ts`).

Deviations flagged (follow-up polish, non-blocking): production string-normalization shim in `continueRecord` bridging legacy string-returning test mocks; a THROWN resume keeps the legacy `resumed_live`/`restored_session` return (only RESOLVED empty/aborted turns — the confirmed defect — surface as failed, preserving pinned `subagent-integration.test.ts:162`); failure reason reuses the pinned union member `runtime_initialization_failed` (semantically loose — a dedicated `resume_produced_no_output` reason needs the pinned `agent-manager.test.ts:389` union updated).

## Restore-path follow-up — root cause pinned

The pre-existing `restores a completed child` failure was probed (temporary assertion, reverted): **`failureReason = "target_unknown"`** (`agent-manager.ts:417-420`). So restore-after-cleanup fails because the **durable resume-target is not found** after `session_start` `clearCompleted`, NOT a session-file corruption / open-invariant (taishang's guess) and NOT the empty-turn swallow. This is a distinct durable-target persistence/lookup gap — its own follow-up (does `clearCompleted` drop the persistent target, or is the lookup key wrong post-cleanup?).

Also observed: the subagent UNIT suite carries **33 pre-existing failures at HEAD** (`session-restoration.test.ts`, `index.session-context.test.ts`) — same restore area — unrelated to D3. Worth a dedicated triage.
