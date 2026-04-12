# Orchestration Flow Design

## Goal

Keep planning, approval, handoff, and execution responsibilities separate.

- **Fu Xi / plan mode** owns request clarification, plan drafting, review, approval flow, and Hou Tu handoff preparation.
- **Hou Tu / execute mode** owns execution after handoff exists.
- **Handoff runtime** owns persisted handoff authority, validation, stale detection, and consume-on-success behavior.

Plan mode must end at **handoff prepared**. It must not start execution.

## High-level lifecycle

### Plan mode lifecycle

1. **Drafting**
   - Fu Xi clarifies request and writes `local://PLAN.md`.
2. **Gap review**
   - Di Renjie reviews latest saved draft.
   - Result recorded with `gap_review_complete`.
3. **Finalized**
   - `finalize_plan` freezes current approved draft metadata and enters approval flow.
4. **Approval pending**
   - User chooses one approval path:
     - direct approval
     - Plannotator approval
     - high-accuracy review
5. **Approved**
   - One approval path succeeds.
6. **Handoff prepared**
   - `exit_plan_mode` or approval success prepares Hou Tu handoff.
   - Mode switches to Hou Tu.
   - Plan mode is done.

### Execution lifecycle

1. **Hou Tu active**
   - Hou Tu starts in execute mode.
2. **Handoff injected**
   - Next Hou Tu turn loads persisted handoff briefing.
3. **Execution runs**
   - Hou Tu executes plan.
4. **Handoff consumed**
   - Successful terminal Hou Tu turn marks handoff consumed.

## Ownership by module

### `extensions/modes/src/plan-tools.ts`
Plan lifecycle tool surface.

- `gap_review_complete`
- `finalize_plan`
- `exit_plan_mode`
- `high_accuracy_review_complete`

Rules:
- `finalize_plan` does **not** hand off.
- `exit_plan_mode` does **not** finalize or review.
- `exit_plan_mode` only prepares approved Hou Tu handoff and leaves plan mode.

### `extensions/modes/src/plannotator.ts`
Approval-flow controller.

Owns:
- approval menu
- Plannotator review start/result handling
- high-accuracy review launch
- approved-plan handoff preparation helper

Does not own:
- Hou Tu execution kickoff
- execution replay
- handoff consumption

### `extensions/modes/src/hooks.ts`
Mode enforcement and runtime bridge.

Fu Xi side:
- plan-mode tool restrictions
- read-only bash restrictions
- plan-write invalidation of approvals
- review recovery

Hou Tu side:
- load pending handoff on next execute turn
- inject `handoff-context`
- trim old planning context
- consume handoff after successful execution turn
- bounce back to Fu Xi if stored handoff is invalid or stale

### `extensions/handoff/src/*`
Persistent handoff authority.

Owns:
- authority record
- stored briefing
- readiness checks
- stale plan detection
- mark-consumed

## Stage notes

### Drafting
Any successful write/edit to `local://PLAN.md` resets approval and handoff state.

### Gap review
Gap review is required before `finalize_plan`.

### Finalized
`finalize_plan` records title + plan snapshot and opens approval flow.
It is the boundary between drafting and approval.

### Approval pending
Approval is a single stage with multiple mechanisms.
Approval sources:
- `user`
- `plannotator`
- `high-accuracy`

### Handoff prepared
A prepared handoff means:
- persisted handoff authority exists
- briefing exists
- Hou Tu mode is active
- execution has **not** started yet

## Design rules

1. **No plan-mode execution kickoff**
   - Plan mode may prepare handoff and switch modes.
   - It may not auto-start Hou Tu execution.
2. **Approval before handoff**
   - Finalized plan must be approved before handoff preparation.
3. **Plan file remains source of truth**
   - `local://PLAN.md` remains canonical plan content.
4. **Handoff must be stale-safe**
   - If `PLAN.md` changes after handoff preparation, runtime must reject stale handoff.
5. **Execution context starts at handoff boundary**
   - Hou Tu should not inherit full planning chatter as execution context.

## Minimal state model

Current implementation still uses a few booleans, but conceptually the lifecycle is:

- `drafting`
- `gap_reviewed`
- `finalized`
- `approval_pending`
- `approved`
- `handoff_prepared`

Execution-only runtime states are separate from plan lifecycle.

## Future refactor direction

If lifecycle complexity grows, move from flag-based orchestration to explicit transition handling:

- `draft_saved`
- `gap_review_recorded`
- `plan_finalized`
- `approval_requested`
- `approval_granted`
- `handoff_prepared`
- `handoff_invalidated`
- `handoff_consumed`

That would keep plan mode and execution mode boundaries strict while preserving current behavior.
