# Subagent + Tasks Modernization Proposal

**Status:** Proposal (no code written yet)
**Date:** 2026-06-01
**Scope:** `extensions/subagent/`, `extensions/tasks/`
**Fork stance (decided):** Hard fork — we stop tracking upstream `@tintinweb/pi-subagents` and `@tintinweb/pi-tasks`. Refactors are no longer constrained by upstream merge cost.
**Target runtime:** pi 0.77.0 (`@earendil-works/pi-coding-agent`)

---

## Goal

De-clunk the two orchestration extensions that the harness depends on, without losing
the behavior the rest of the repo (modes, handoff, task-continuation-reminder, profiles)
already relies on. Reduce the "POC feel" that comes from two monolithic entrypoints,
fix the correctness gaps found in the audit, and align the code with the pi 0.77 API
surface and modern agent-orchestration practice.

## Non-goals

- Do **not** change the public event/RPC contract (`subagents:*`, `subagents:rpc:*`,
  `tasks:rpc:*`, `:reply:${requestId}`) in phase 1–2. Other extensions depend on it.
  A contract change is a separate, later proposal.
- Do **not** remove or rename the public tools (`Agent`, `get_subagent_result`,
  `steer_subagent`, `TaskCreate/List/Get/Update/Execute/Output/Stop`) or the `/agents`
  and `/tasks` commands.
- Do **not** change on-disk task schema (`.pi/tasks/`) or config path
  (`.pi/tasks-config.json`) without an explicit migration step.
- Do **not** delete either extension. pi 0.77 ships **no** built-in subagent or task
  primitive (README: "skips features like sub agents and plan mode"), so nothing
  supersedes them.

---

## Background: what we are actually starting from

Both extensions are vendored upstream packages, not in-house POCs:

| Extension | Package | Version | Source files | Tests |
|-----------|---------|---------|--------------|-------|
| `subagent/` | `@tintinweb/pi-subagents` | 0.6.3 | ~30 | ~25 test files |
| `tasks/`    | `@tintinweb/pi-tasks`     | 0.5.0 | ~8  | ~6 test files |

They are well-tested and have substantial tracked local divergences (see each
`AGENTS.md` → "Local Tweaks"). The "clunky / POC" feeling is **not** spread across the
codebase — it is concentrated in two god-file entrypoints:

- `extensions/subagent/src/index.ts` — **2063 lines**
- `extensions/tasks/src/index.ts` — **1267 lines**

Each mixes 5 concerns: tool registration, UI/widget rendering, notifications,
event/RPC wiring, and lifecycle bookkeeping. Both `AGENTS.md` files acknowledge this
("`src/index.ts` is large because it owns ... many changes fan out from there";
"text-only edits can change agent behavior materially").

Because the fork stance is now **hard fork**, the historical reason to keep these files
upstream-shaped (cheap `git` syncs) no longer applies. We can restructure.

---

## Audit findings (evidence)

### subagent/

1. **God-file hub.** `src/index.ts:1-2063` owns tool registration + widget rendering +
   notifications + event emission + the background-supervision loop/timer. Sibling
   modules (`agent-manager.ts`, `agent-runner.ts`, `agent-types.ts`, `ui/*`) are
   reasonably factored; the hub is where complexity collects.

2. **Background supervision mis-fires on non-streaming work.** `src/background-supervision.ts`
   + the loop in `index.ts` auto-steer idle agents (`BACKGROUND_STALE_STEER_AFTER_MS`)
   and can auto-abort. Observed failure during this very audit: a recon subagent was
   terminated mid-synthesis, then idle-pinged into a hollow "Done" answer.
   **Correction (taishang review):** supervision is *already* token-aware — `markProgress()`
   fires on `onTextDelta`, tool activity, and turn end (`index.ts:114-142`), resetting
   `lastProgressAt`. The real false-idle windows are: **non-streaming providers** (no
   `text_delta` events — the class `result-recovery.ts` already exists for), **reasoning/
   thinking phases** (reasoning deltas aren't `text_delta`), and **long single tool calls**
   (tool *start* marks progress once, then abort can fire mid-call). The fix is narrower
   and different from "add token-awareness" — see revised Phase 1.1.

3. **In-memory-only lifecycle state.** `AgentManager` holds running/queued agents in
   memory maps. Nothing survives a pi restart → background agents orphan; the parent
   loses the ability to collect results. Note: subagent **session JSONL** is already
   persisted under `~/.pi/agent/subagent-sessions/<parent>/`, so the transcript exists;
   the *coordination state* (which agent maps to what, status) does not.

4. **Dependency drift.** `package.json` peerDeps pin `^0.73.0`; installed pi is
   **0.77.0** (4 minor versions). Not verified against the current API surface.

### tasks/

5. **God-file hub.** `src/index.ts:123-1267` mixes tool specs, lifecycle hooks
   (`turn_start/turn_end/tool_result/before_agent_start/session_switch`), widget,
   auto-clear, planning-provenance cleanup, and the subagent RPC bridge.

6. **Soft DAG enforcement.** `src/task-store.ts:216-244`: self-blocks, dangling edges,
   and cycles only push **warning strings** — the bad edge is still written to disk.
   Cycle detection only catches direct 2-cycles (A↔B), never transitive (A→B→C→A).
   `TaskExecute` gates on `blockedBy`, so a corrupt graph can deadlock or mis-run tasks.

7. **Silent validation.** Bad JSON is swallowed (`task-store.ts:75-83`,
   `tasks-config.ts:15-18`) — a corrupt store/config degrades silently instead of
   surfacing.

8. **Concurrency assumptions.** Writes use a lock + atomic tmp-rename
   (`task-store.ts`), but reads are unlocked and `cascadeConfig`/`agentTaskMap` are
   in-memory only. Multi-session or restart scenarios can desync.

9. **Magic numbers.** `4` (reminder interval / auto-clear delay), `150ms`, `10`, `30s`,
   `10s`, `5s`, `4KB` buffer, protocol `2` — scattered, undocumented.

### Cross-cutting

10. **Duplicated RPC plumbing.** `rpcCall` / `handleRpc` are re-implemented in each
    extension. The contract is identical and stable (`requestId`, scoped reply,
    unsubscribe-on-settle, timeout — verified correct at `tasks/src/index.ts:166-199`).
    Prime candidate for `extensions/lib/rpc.ts`.

11. **Duplicated domain helpers.** Blocker-filtering and status-grouping logic are
    repeated between tool handlers and widget renderers in `tasks/`.

### What is *good* (do not "fix")

- The `subagents:rpc:*` ↔ `tasks` bridge is contract-correct and version-aware
  (`ping` handshake, `subagents:ready` discovery). Keep it.
- Parent-scoped subagent session logging keeps the main `/tree` clean. Keep it.
- Regression test coverage is genuinely strong. Treat it as the safety net for refactors.

---

## pi 0.77 capabilities we can lean on

(from local `@earendil-works/pi-coding-agent` 0.77.0 docs/types)

- `ExtensionAPI`: `registerTool` / `defineTool` (schema-first, TypeBox), `registerCommand`,
  `registerShortcut`, `registerMessageRenderer`, `appendEntry`, `sendMessage` /
  `sendUserMessage`, `on(...)` lifecycle hooks, shared `events` bus.
- `SessionManager` / `AgentSessionRuntime`: `newSession`, `switchSession`, `fork`,
  `importFromJsonl`, branching/labels, `list`/`open`/`continueRecent`.
- `appendEntry` → durable, session-log-backed state (survives restart).

Implication: durable coordination state and richer session handling are achievable on
0.77 primitives instead of bespoke in-memory maps.

## Orchestration practice (external, for direction)

Convergent guidance from LangGraph (supervisor + durable execution), Temporal
(durable state, message passing, sensible timeouts), and AutoGen (explicit handoffs):
prefer **explicit supervisor/handoff graphs with durable state** over **polling loops
and shared mutable state**. Our current setup leans on a polling supervision timer and
in-memory maps — the two things this guidance steers away from.

---

## Proposed roadmap (phased, each phase independently shippable + verifiable)

### Phase 1 — Correctness (low risk, do first)

> Revised after taishang review (2026-06-01). Ordering matters: bump deps first, build
> the missing test net second, then fix. 1.6/1.7 from the earlier draft are **removed
> from Phase 1** (1.6 → separate feature batch "Phase 1.5"; 1.7 → Phase 4). "Zero test
> diff" is **not** a Phase 1 goal — 1.1/1.2/1.3 legitimately change behavior and tests.

| Order | # | Change | Files | Verify |
|-------|---|--------|-------|--------|
| 1 | 1.5 | Bump peerDeps to pi 0.77 + run full suites; fix API drift **before** building on the surface | both `package.json` | `pnpm test:extensions`, `pnpm lint:typecheck` |
| 2 | 1.0 | Add the missing regression tests *first* (build the net where the holes are): non-streaming/long-tool supervision, transitive cycle, corrupt-store reload | `subagent/test/background-supervision.test.ts`, `tasks/test/task-store.test.ts` | new tests red → then green after fixes |
| 3 | 1.3 | Corrupt store/config JSON: **warn once + rename to `.corrupt` + start fresh; never throw from `load()`** (it runs on every locked mutation, `task-store.ts:102`) | `tasks/src/task-store.ts`, `tasks/src/tasks-config.ts` | malformed-input test asserts no throw + visible warn |
| 4 | 1.1 | Supervision fix (correctly framed): count **reasoning/thinking deltas** as progress; **detect non-streaming providers** → disable abort or raise thresholds 5-10×; **never abort while `activeTools.size > 0`**; reconcile with existing `result-recovery.ts` | `subagent/src/background-supervision.ts`, hub loop | simulate non-streaming long turn → assert no abort; long-tool-call → assert no mid-call abort |
| 5 | 1.2 | DAG + status FSM: **reject new** self/dangling/cyclic edges at write; **transitive** cycle detection; on load **quarantine** pre-existing bad edges (drop+warn, don't throw); status FSM that **enumerates all ~10 legal internal transitions** (`index.ts:359/371/384/404/408/1009/1095/1110/1241`) and rejects only *agent-supplied* illegal ones | `tasks/src/task-store.ts`, `tasks/src/index.ts` | transitive-cycle fixture; assert internal cascade transitions still legal; migration normalizes existing `.pi/tasks` |
| 6 | 1.4 | Name the magic numbers as documented constants (pure cleanup, last) | both `index.ts` | typecheck; no behavior change |

Gate: 1.5 green before anything; new tests (1.0) added before their fixes; manual QA of 1.1 (non-streaming) and 1.2 (cascade + migration).

Observability requirement (cross-cutting, taishang): emit a structured warn line whenever supervision aborts (with the reason class) and whenever a DAG edge is rejected/quarantined — needed to confirm the 1.1 fix works in the wild.

### Phase 2 — Break up the god-files (enabled by hard fork)

Carve each `index.ts` into focused modules, entrypoint becomes thin wiring only:

```
subagent/src/
  index.ts              # register + wire only (<300 lines target)
  tools/                # Agent, get_subagent_result, steer_subagent definitions
  lifecycle/            # supervision loop, notifications
  ui-wiring/            # widget/notification glue (rendering already in ui/)

tasks/src/
  index.ts              # register + wire only (<300 lines target)
  tools/                # 7 tool definitions
  lifecycle/            # turn/tool/session hooks, auto-clear, planning cleanup
  bridge/               # subagent RPC bridge
```

- De-duplicate domain helpers (blocker filter, status grouping) into one module per
  extension; widgets and tools consume the same functions.
- No public contract change. Tests should pass unchanged (they target behavior, not
  file layout) — that is the proof the split is faithful.

Gate: zero test diffs needed beyond import paths; line count of each `index.ts` < ~300.

### Phase 3 — Shared RPC lib (small, cross-cutting)

- Extract `extensions/lib/rpc.ts` with `rpcCall` / `registerRpcHandler` implementing
  the repo `CONVENTIONS.md` envelope. Both extensions import it.
- Add a focused unit test for the lib; existing `cross-extension-rpc.test.ts` and
  `subagent-integration.test.ts` remain the integration guard.

Gate: integration tests green; one source of truth for the envelope.

### Phase 4 — Durable coordination state (optional, larger)

- Persist subagent coordination state and task `agentTaskMap`/`cascadeConfig` via
  `appendEntry` (session-log-backed) so background agents and task↔agent links survive
  a pi restart. Model the parent↔child linkage on opencode's session tree (`parentID`);
  accept that live runtime status stays ephemeral (even opencode's job tracker is in-memory).
- Add a **versioned on-disk task schema** (OMO-style high-watermark) so future migrations
  are safe.
- **Compaction survival** (moved here from the earlier Phase 1.7): snapshot task/active-task
  state on `session_before_compact`, restore on `session_compact`. Shares the `appendEntry`
  durability machinery, hence grouped here.
- This is the phase that touches persisted shape → requires a migration note and an
  `AGENTS.md` "Ask First" sign-off. Defer until Phases 1–3 land.

---

## External design learnings (opencode + oh-my-openagent)

Reviewed two reference implementations on 2026-06-01. Both **validate** the direction
above and contribute concrete patterns. All steals below are grounded in real pi 0.77
API (`session_before_compact` / `session_compact` events, `ctx.session.idle` flag,
`appendEntry`, `newSession`/`fork`/`importFromJsonl`).

### From anomalyco/opencode (subagent)

| Pattern | Evidence | Where it lands |
|---------|----------|----------------|
| **Event-driven result delivery, gated on *parent* idle.** `task(background=true)` returns immediately; the parent is re-prompted with the child result **only when the parent session is idle** (`SessionPrompt` / `continueIfIdle`). This is a *result-delivery* mechanism, **not** a child-killing one — there is no timer that aborts a busy child. | `tool/task.ts`, `session/prompt.ts`, `background/job.ts` | **Two distinct mechanisms** (taishang): (1) child liveness stays per-child via `lastProgressAt` (Phase 1.1); (2) pi's `ctx.session.idle` is the *parent* signal and is used **only** to gate when background results/reminders surface. Do **not** use parent `session.idle` as a child-liveness proxy. |
| **Durable parent→child session tree.** Sessions are rows with `parent_id`; `children()` queries them; resume targets the same child session. | `session/session.ts` (`Session.create({ parentID })`) | **Sharpens Phase 4** — persist the parent↔child *linkage* (via `appendEntry` + session reasons), not the live job runtime. |
| **Separation of concerns.** Session UI split across route + header + tree dialog, not one file. | `routes/session/*` | **Validates Phase 2.** |
| **Permission inheritance.** Child derives permissions from parent + subagent rules. | `tool/task.ts`, `agent/agent.ts` | We already approximate this (delegation-policy + tool allowlists); no change, but confirms the model. |

**Key nuance:** opencode's `BackgroundJob` tracker is *itself in-memory* (`SynchronizedRef<Map>`) — durability comes from the **session DB tree**, not the job map. Lesson for Phase 4: persist the durable *linkage/coordination facts*, accept that live runtime status stays ephemeral.

### From code-yeongyu/oh-my-openagent (task) — our orchestrator's own lineage

| Pattern | Evidence | Where it lands |
|---------|----------|----------------|
| **Finite status FSM + cross-owner guard.** `updateTaskStatus` enforces a transition table; illegal transitions are rejected, not assigned. | `team-mode/team-tasklist/update.ts` | **New, add to Phase 1.2** — we currently assign `status` directly. Add a transition table. |
| **Claim-time blocker gate.** `claimTask` *rejects* a task whose `blockedBy` is unresolved (enforcement at execute time, not just edge-creation). | `team-mode/team-tasklist/claim.ts` | **Strengthens Phase 1.2** — enforce in `TaskExecute`, not only when an edge is added. |
| **Skip-and-surface malformed JSON.** `listTasks` skips bad records instead of crashing; storage uses atomic temp→rename + lock. | `team-tasklist/list.ts`, `claude-tasks/storage.ts` | **Sharpens Phase 1.3** — skip *and* warn; we already have atomic+lock. |
| **Versioned JSON + high-watermark IDs.** Store carries a schema version. | `team-tasklist/store.ts` | **Add to Phase 4** — version the on-disk schema so future migrations are safe. |
| **Smarter continuation enforcer.** Idle-injected reminders with cooldown + backoff + stagnation caps; skips during background tasks / pending questions / compaction. | `hooks/todo-continuation-enforcer/*` | **Separate feature batch ("Phase 1.5")**, not Phase 1 — it's a new feature, not a fix. Our reminder is a fixed `REMINDER_INTERVAL = 4`. |
| **Compaction survival.** Snapshots todos before compaction, restores on `session.compacted`. | `hooks/compaction-todo-preserver/hook.ts` | **Moved to Phase 4** (taishang) — persistence-adjacent, shares `appendEntry` machinery, and depends on `session_before_compact`/`session_compact` events not yet wired in these extensions. |
| **Modular store/tool/hook split.** | `tools/task/*`, `features/claude-tasks/*`, `hooks/*` | **Validates Phase 2.** |

**Caveats from the research:** OMO's *legacy* task path is still soft-DAG (the strong enforcement lives only in team-mode); and both repos at times treat a **missing blocker ID as satisfied** — a documented bypass risk. Our hardening must do the opposite: **a dangling blocker is unsatisfied, not ignored.** Do **not** copy OMO's agent-loop machinery wholesale (`session.todo` sync, `taskReminder` is unwired) — only the durability + validation + separation patterns transfer.

### Net phase changes from this review

- **Phase 1 = pure correctness only:** 1.5 (deps) → 1.0 (test net) → 1.3 (corrupt JSON) → 1.1 (supervision) → 1.2 (DAG+FSM) → 1.4 (constants). See revised Phase 1 table.
- **Phase 1.2 (expanded):** status FSM enumerating all legal *internal* transitions + claim-time blocker rejection in `TaskExecute`; dangling blocker = **unsatisfied**; on-load **quarantine** of pre-existing bad edges + migration of existing `.pi/tasks`.
- **Phase 1.5 (new, separate batch):** cooldown/backoff/stagnation-capped continuation reminder.
- **Phase 4 (expanded):** parent↔child session linkage (opencode), versioned task schema (OMO), **and** compaction survival via `session_before_compact`/`session_compact` (moved from Phase 1.7).

---

## Risks

- **"Zero test diff" is a Phase 2 guarantee only.** Phases 1.1/1.2/1.3 legitimately change
  behavior and *will* add/change tests — that is expected, not a red flag. Only Phase 2
  (the structural split) must pass existing tests unchanged.
- **Hard-fork bookkeeping.** Both `README.md` + `AGENTS.md` currently frame changes as
  "preserve on upstream sync." After this proposal lands, update provenance to "forked
  at v0.6.3 / v0.5.0; no longer synced" and retire the "Local Tweaks (preserve on sync)"
  framing.
- **Phase 4 only** carries data-shape risk. **Exception (taishang):** Phase 1.2 DAG
  hardening also touches *existing* on-disk graphs — it needs a load-time quarantine +
  migration pass, not just future schema versioning.
- **`Symbol.for("pi-subagents:manager")` global** (`subagent/src/index.ts:627`) is shared
  mutable cross-package state. Acceptable in the current implementation, but it is the one
  coordination point Phase 4 durability cannot fully eliminate — note it, don't fight it in Phase 1–3.

## Open questions

1. Phase 4: is restart-durable background-agent state actually wanted, or do orphaned
   background agents on restart match current expectations?
2. Should the hard fork be reflected by renaming the packages
   (`@tintinweb/*` → repo-local scope) to stop implying upstream lineage?

## Review log

- **2026-06-01 — taishang architecture review.** Verdict: **yes-with-changes**. Direction
  sound; Phases 2/3/4 well-reasoned. Corrections incorporated above:
  - **B1:** Phase 1.1's original premise ("supervision ignores output") was *false* — it's
    already token-aware (`index.ts:114-142`). Real bug = non-streaming providers / reasoning
    deltas / long single tool calls. Phase 1.1 reframed.
  - **B2:** `ctx.session.idle` is a *parent* signal; do not use it as a child-liveness proxy.
    Two separate mechanisms now documented.
  - **M3/M4:** status FSM must enumerate ~10 legal internal transitions; DAG hardening must
    quarantine pre-existing bad on-disk edges + migrate, not throw. "Zero test diff" scoped
    to Phase 2 only.
  - **M5:** `load()` is a per-mutation hot path — corrupt-JSON handling must warn+quarantine,
    never throw.
  - **M6:** Phase 1 was too big; 1.6→1.5 batch, 1.7→Phase 4.
- **Still-open misses flagged by taishang (track during implementation):**
  1. **Migration** of *pre-existing* bad/corrupt `.pi/tasks` data (not just future schema).
  2. **Observability** — structured warn lines on supervision abort (with reason class) and
     on edge reject/quarantine; without them we can't confirm the 1.1 fix in the wild.
  3. **Test net before refactor** — add coverage for the exact holes (non-streaming
     supervision, transitive cycle, corrupt reload) *before* touching code (Phase 1.0).
  4. **Reconcile with `result-recovery.ts`** — the existing non-streaming fallback overlaps
     the 1.1 fix; unify rather than duplicate.

## Recommendation

Land **Phases 1 → 2 → 3** in order, with Phase 1 in the revised sequence
(1.5 → 1.0 → 1.3 → 1.1 → 1.2 → 1.4). Phase 1 removes the felt clunk (supervision
mis-firing on non-streaming work, soft DAG, silent failures). Phase 2 removes the
structural clunk now that the fork is free. Phase 3 removes the last duplication. Hold
Phase 4 (durable linkage + schema versioning + compaction survival) pending answers to
the open questions.
