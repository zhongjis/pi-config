## Purpose

Maintain thread-scoped goals, autonomous continuation, and usage accounting.

## Ownership

- Owns goal state, commands/tools, continuation prompts, and token/time accounting.
- `src/goal/context.ts` owns shared context-to-store resolution and read-only Goal lookup; consumers MUST preserve lookup errors and NEVER duplicate storage paths.
- [QoL](../qol/AGENTS.md) owns the shared footer; goal publishes its indicator bridge.

## Local Contracts

- Accounting MUST survive session restoration and flush on shutdown.
- Active continuation MUST respect goal status and optional token budgets.
- Any existing Goal record, including stopped/complete states, suppresses Tasks-owned continuation; this boundary NEVER changes Goal scheduling.
- User Stop MUST persist paused across reopening and ordinary input; only explicit `/goal resume` or objective-setting may reactivate it. Provider errors NEVER imply user Stop.
- Model mutations MUST be identity/status/control-generation guarded and NEVER mutate paused Goals or change budgets.
- Blocking MUST persist a trimmed nonempty reason and timestamp; leaving blocked MUST clear metadata. Legacy records without metadata remain readable.
- The blocked audit MUST exhaust authorized paths and repeat the same external-state or necessary unanswered-user impasse for ≥3 consecutive Goal turns. This is a floor, NEVER an attempt cap; live results/questions remain waits. Runtime MUST NOT claim semantic proof or universal wake-source observation.
- Storage MUST serialize whole mutations with Pi's native queue and publish atomically; one active Pi owner per session is the process-local concurrency boundary.
- Continuation MUST share identity/generation-safe single-flight admission; automatic continuation uses clean native pre-settlement boundaries, NEVER `agent_end` fresh runs.
- User cancellation MUST remain paused after final accounting, including over-budget usage. Completion usage and the one budget wrapup remain preserved.
- Objective prompts MUST treat Goal data as untrusted, preserve nonconflicting scope against newer input, and map verification evidence to each requirement.
- Goal display MUST use the QoL bridge when present; standalone footer is fallback only.
- Compact rendering MUST preserve model-visible result content.
- Fresh `/goal <objective>` identities MUST confirm with `Goal started` and the objective only, omitting duplicate status and zero usage. Inspection, completion, and same-identity objective-setting/resume MUST retain full usage and any existing budget; objective syntax does not set budgets.

## Work Guidance

- Independently maintain Goal; you MUST preserve [origin attribution](README.md#origin-and-maintenance) and [LICENSE](LICENSE).
- [README integration](README.md#display-and-integration) describes rendering and footer integration deltas.
- Accounting and footer changes SHOULD remain separate concerns.

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/goal/test`.
- Native lifecycle: `pnpm exec vitest run --project integration test/integration/goal.integration.test.ts test/integration/tasks-continuation.integration.test.ts`.
- [Continuation](test/continuation.test.ts), [store](test/store.test.ts), and [footer bridge](test/footer-bridge.test.ts) provide focused coverage.

## Child DOX Index

- None; this document owns the entire subtree.
