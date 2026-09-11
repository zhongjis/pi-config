## Purpose

Maintain persistent task tracking, dependencies, and task supervision state.

## Ownership

- Owns the `Task` tool, task store, widget, continuation state, and task RPC handlers.
- Planning producers and handoff callers retain their own orchestration responsibilities.

## Local Contracts

- Batch creation MUST remain all-or-nothing on malformed input.
- Batch updates MUST remain best-effort, with per-item acceptance/rejection reporting.
- Dependency edges MUST remain bidirectional; deletion removes the task and its edges.
- Persistence MUST retain advisory locking and atomic replacement.
- Schema-v1 migration MUST occur on first write under lock, preserving pre-v2 snapshots.
- State-machine changes MUST preserve illegal-transition and late-reply protections.
- Finish nudges MUST enroll only successful Task create/update IDs in the current real-user episode; only unowned local execution tasks qualify.
- Finish nudges MUST stop at two or earlier without forward status progress; synthetic turns NEVER reset the allowance.
- Goal records in every status own continuation; Goal lookup failures MUST suppress task nudges.
- Automatic follow-ups MUST respect child, user/mode, worker/process waits and clean settlement; asynchronous decisions MUST recheck live state.
- Nudges NEVER mutate tasks; stagnation/cap emits one visible unresolved notice.
- Finish listeners MUST attach only at session_start and detach on shutdown; filtered factories NEVER subscribe.
- Nudge prompts MUST bound task summaries and require dependency order plus verification before completion.

## Work Guidance

- [README](README.md) owns tool semantics, scope settings, storage, and RPC names.
- You MUST preserve [upstream provenance and adaptations](README.md#upstream) and [LICENSE](LICENSE).
- Store changes SHOULD use existing migration, DAG, and corruption regressions.

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/tasks/test`.
- [Task tool](test/task-tool.test.ts), [FSM](test/fsm-illegal-transition.test.ts), and [migration](test/migration-idempotent.test.ts) tests cover distinct contracts.
- [Finish continuation](test/finish-continuation.test.ts) covers episode bounds, Goal authority, eligibility, waits, and asynchronous invalidation.

## Child DOX Index

- None; this document owns the entire subtree, including migrations and regressions.
