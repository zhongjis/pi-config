# Agent Development Cycle: Kuafu

Status: idea

Source: [`modes/kuafu/gpt.md`](../../modes/kuafu/gpt.md).

This non-binding note records the development lifecycle prescribed by Kuafu's GPT prompt. It describes prompt instructions, not verified runtime enforcement. The source prompt remains authoritative for this summary.

Kuafu owns scope, delegation, supervision, and final verification—not every edit.

## Lifecycle

```text
User request
│
├─ 1. Gate intent
│     Research, review, or explanation: inspect, answer, and propose; do not edit.
│     Open-ended improvement: assess and propose a route before editing.
│
├─ 2. Understand
│     Load applicable skills and project rules.
│     Inspect relevant code, patterns, and tests.
│     Consult Taishang when consequential decisions require it.
│
├─ 3. Gate implementation
│     Confirm explicit authorization, clear scope and constraints,
│     collected specialist results, known work shape, and a verification path.
│     If any condition is missing, research, clarify, or propose; do not edit.
│
├─ 4. Package work
│     Track non-trivial tasks and mark them in progress before starting.
│     Keep implementation and its tests in one cohesive packet.
│     Split independently verifiable outcomes with non-overlapping writes.
│     Parallelize only independent work.
│
├─ 5. Execute
│     Kuafu: trivial local work when cheaper than delegation.
│     Guangguang: eligible trivial worker packets.
│     Jintong: default bounded non-UI implementation.
│     Yunu: frontend implementation.
│     Juling: work with an explicit reasoning or risk escalation trigger.
│
├─ 6. Supervise
│     Track workers, steer drift, and collect results.
│     Resume salvageable sessions instead of restarting.
│     Workers run focused regression checks and file-local lint/format.
│
├─ 7. Verify — Kuafu owns this
│     Read changed files and review the full applicable diff.
│     Inspect actual commands, scope, output, and exit status.
│     Obtain parent-owned executable integration evidence.
│     Check affected user-visible behavior and interactions.
│     Reuse valid evidence; run missing, invalidated, or required checks.
│
└─ 8. Close
      Recheck the original request, scope, and acceptance criteria.
      Mark tasks complete only after verification passes.
      Report the verified result or a precise blocker.
      Stop without unrelated cleanup or an implicit commit/push.
```

## Delegation and consultation boundaries

- Each worker receives one decision-complete, independently verifiable task. Keep coupled implementation and tests together rather than splitting by file count.
- Juling requires a positive trigger: architecture, data ownership, trust boundaries, security, concurrency, migration, performance invariants, ambiguous debugging after focused reconnaissance, cross-workstream integration, or a diagnosed standard-worker reasoning failure. Size or importance alone does not qualify.
- Consult Taishang for consequential boundary decisions, non-local security or performance trade-offs, conflicting hard constraints, or an explicit user request. Collect required advice before dependent actions.
- Missing context calls for a better packet at the same worker tier. Tool failures call for repair and retry. Unexpected coupling calls for replanning. These do not automatically justify escalation.
- Keep indivisible work resumable, with ordered steps, at least one intermediate green checkpoint, and a fail-safe that reports where to resume.

## Failure loop

```text
Attempt 1
  Use the strongest evidence to identify the root cause and make a minimal fix.

If attempt 1 fails
  Test a materially different hypothesis and strategy for attempt 2.

If attempt 2 fails
  Consult Taishang before attempt 3.

If attempt 3 fails
  Restore only agent-owned edits to the last verified green state.
  Preserve user and concurrent changes; stop if ownership is uncertain.
  Rerun focused checks.
  Report failures, a resume anchor, and one precise question.
```

## Completion boundary

A worker reporting “done” does not make the task complete. Kuafu must inspect the changes and execution evidence and obtain appropriate parent-owned integration evidence for the combined result. Valid evidence may be reused; a phase boundary alone does not justify rerunning checks.

Verification never authorizes pushing. Missing input, permission, or capability must be reported as a blocker rather than hidden behind a completion claim.
