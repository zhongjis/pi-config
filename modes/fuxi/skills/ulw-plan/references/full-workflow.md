---
name: ulw-plan
description: Full ulw-plan workflow - the deep mechanics both intent paths share. Explore-first, ask only genuine unknowns (or research them to best practice when intent is fuzzy), wait for explicit approval, then produce one decision-complete plan.
metadata:
  short-description: Shared deep mechanics for the ulw-plan skill
---

# ulw-plan - full workflow

Load this shared stage only when approaching approval or producing the plan. CLEAR and UNCLEAR grounding behavior remains canonical in `intent-clear.md` and `intent-unclear.md`.

Fu Xi remains planner-only. Write only `local://DRAFT.md` and `local://PLAN.md`; never implement directly or through a child. Plan mode stays sticky. Approval creates a plan, never starts execution. Final delivery calls `plan_approve`; only user invocation of `/handoff:start-work` starts Hou Tu.

## Approval gate

This gate is the only transition from finished brief to plan creation. Persist it as a decision, not a passphrase hunt.

When branch clearance passes:

1. Update `local://DRAFT.md` to `status: awaiting-approval`; record approach and next action (`write local://PLAN.md` or `write and review local://PLAN.md`). This is the compaction loop guard.
2. Present the brief once. CLEAR includes cited findings, approach, and every surviving owner decision with recommended option. UNCLEAR leads with routing, derived approach, Components, and every adopted default copied from the draft with rationale/reversibility.
3. Wait for explicit user approval.

Interpret the next reply:

- Approval: an after-brief acceptance such as "yes", "approve", "proceed", "write the plan", or answers to open CLEAR forks. Original request to plan is not approval. Create exactly one plan; never implement.
- Scope change: update draft and approach, then present the revised brief once.
- Still unclear: emit one short line naming pending action and needed approval. Never re-explore or repeat the full brief.

No plan and no execution before approval. Narrow bootstrap exception: `/handoff:start-work` with no selectable plan counts as approval to generate one plan only. After review, call `plan_approve` and stop; execution requires a later `/handoff:start-work`.

## Produce the plan

1. After approval only, call `plan_scaffold({ slug: "<slug>", intent: "<clear|unclear>" })` without `draftOnly: true`. Existing draft remains; plan skeleton is created. Plain rerun is a no-op. Never invoke `scripts/scaffold-plan.mjs`.
2. Spawn mandatory `direnjie` gap analysis for contradictions, missing constraints, scope creep, unvalidated assumptions, missing acceptance, and branch-required contrarian review. Fold findings silently.
3. APPEND todo batches under `## Todos` with edit. Never rewrite tool-emitted headers. Any todo count is allowed; one request → one plan.
4. Complete detailed sections, then fill `## TL;DR (For humans)` LAST. UNCLEAR copies the same routing statement and adopted defaults announced from the draft before approval.
5. Run binary completion checks below. Repair every failure before review or handoff.

### Canonical headers

The plan contains these eight `## ` headers exactly once and in this order; `## TL;DR (For humans)` is first:

```
## TL;DR (For humans)
## Scope
## Verification strategy
## Execution strategy
## Todos
## Final verification wave
## Commit strategy
## Success criteria
```

### Task grammar and template

Every executable item is a column-zero task row. Implementation rows match `- [ ] N. <title>` with unique positive decimal `N`; final rows match `- [ ] F<number>. <title>`. Prose, headings, nested rows, and ordinary bullets never count as tasks.

Target 5-8 todos per wave; fewer than 3 except final often signals under-splitting. Size each todo as the coarsest cohesive packet that is decision-complete, independently verifiable, and fits one worker run. Split only for independent outcome, context, or verification boundaries, or worker-budget overflow. Merge tiny tasks that share writes or verification. Implementation plus tests is one todo; never split them to feed a cheaper worker. No fixed file-count guard. Preserve one logical plan item → one resumable worker session, staged with a green checkpoint and last-green fail-safe when oversized.

Worker-fit rubric: Guangguang = mechanical, deterministic, low-risk, trivial single-file, no unresolved design; Jintong = DEFAULT bounded non-UI implementation, including cohesive multi-file changes; Juling = exception requiring a recorded positive trigger; Yunu = frontend owner.
Juling triggers: architecture/data-ownership/trust-boundary reasoning; security/concurrency/migration/performance invariant; ambiguous debugging after focused recon; cross-workstream integration; diagnosed standard-worker reasoning failure. Size, file count, importance, or uncertain estimate alone are not triggers.
Failure classification: Missing context/input → enrich packet and retry same tier. Tool/runtime failure → repair and retry same tier. Unexpected coupling → replan and merge. Only diagnosed reasoning-capability failure or increased risk escalates.

Each implementation todo contains:

```
- [ ] N. <title>
  Objective: <one observable outcome>
  Artifacts: <exact code/doc/result expected>
  Worker fit: <Guangguang | Jintong | Juling | Yunu> — advisory; runtime owns selection
  Escalation triggers: <positive Juling trigger(s) or none>
  Must-have IDs: <M1, ...>
  What to do / Must NOT do: <decision-complete instructions>
  Parallelization: Wave <N> | Blocked by: <IDs or none> | Blocks: <IDs or none>
  References: <exhaustive path:lines and named patterns>
  Acceptance criteria: <agent-executable commands/assertions>
  QA scenarios: happy + failure, exact tool/invocation, evidence path for each
  Commit: <Y/N> | <type>(<scope>): <summary>
  Recommended Max Turns: <positive integer>
```

Scope gives every Must-have a stable ID (`M1`, `M2`, ...). Must-NOT-Haves are explicit guardrails, never reduced requested scope. Dependency matrix lists Todo, Depends on, Blocks, and parallel peers.

## Binary pre-handoff completion checks

Every item must pass:

- Exactly eight canonical headers; each appears once and in order.
- No scaffold placeholders or sentinels remain: no `<fill...>`, template task, instructional comments, placeholder IDs, or unresolved template text.
- Every Must-have has a stable ID and maps to at least one todo.
- Every todo maps to at least one Must-have and none maps to a Must-NOT-Have.
- Dependency matrix contains every implementation todo exactly once, no unknown IDs, and matches each todo's dependency fields.
- Every todo has Objective, Artifacts, advisory Worker fit, Escalation triggers, exhaustive references, executable acceptance, happy + failure QA with exact invocation/evidence, Commit, and Recommended Max Turns.
- F1-F4 each appear exactly once after all implementation todos:
  - `- [ ] F1. Plan compliance audit` — `taishang`.
  - `- [ ] F2. Code quality review` — Hou Tu runs the `orchestrator-owned code-quality gate`.
  - `- [ ] F3. Real manual QA` — Hou Tu drives applicable UI/browser/CLI/API surface.
  - `- [ ] F4. Scope fidelity` — `direnjie`.
- Success criteria cover every Must-have ID with an executable done condition.
- If review is required, both approval receipts bind the current live plan digest.

F1-F4 run after ALL todos, concurrently where independent; ALL must approve. Rejection leaves its gate in progress/unchecked, repairs responsible work, then reruns every invalidated gate. Hou Tu surfaces all four approvals and waits for explicit user okay before completion.

## Review boundary

When `review_required` is false, do not load heavy review machinery. When a complete plan makes required or user-selected review actionable, load `review-lifecycle.md`; it is canonical for request/round state, digest/CAS, reviewer intake, retries, receipts, and live-plan validation.

Review workers use only supported syntax. Launch with `Agent(..., run_in_background=true, inherit_context=false)`. Wait for a known lane only with:

```
get_subagent_result({ agent_id, wait: true })
```

Elapsed time never implies failure or cancellation. Never duplicate or replace a running reviewer because of elapsed time.

## Deliver and stop

- CLEAR, `review_required: false`: present summary through `plan_approve`. If user selects high-accuracy review, run `review-lifecycle.md`, then present final result through `plan_approve` again.
- CLEAR, `review_required: true`: complete dual review, record receipts, then present summary and result through `plan_approve`; do not ask whether to review.
- UNCLEAR non-Trivial: complete automatic dual review, then present summary leading with derived approach and adopted defaults through `plan_approve`. Trivial suppresses automatic dual review unless explicitly requested.

After `plan_approve`, stop. Approval never begins execution; only user may invoke `/handoff:start-work`.
