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
- Native cancellation MUST persist paused and arm one durable offer for fresh ordinary interactive/RPC input. Keep paused is first/default; dismissal or no UI consumes the offer without resuming. Provider errors NEVER arm it.
- Confirmed input MUST atomically append verbatim text and resume the same Goal in the original user run, preserving objective, identity, creation time, usage, time and budget. Explicit controls clear obsolete offers; stale consent NEVER mutates a replacement or re-paused Goal.
- Active interactive/RPC steer MUST append at submission without dialogs or cancellation-generation invalidation. Acceptance survives abort, belongs only to the accepting Goal, and NEVER claims native delivery. Extension inputs and commands are excluded; native text, images, expansion and scheduling remain untouched.
- Amendments MUST remain ordered, separately persisted and escaped as untrusted prompt data. Hidden continuation context MUST match the current amendment version; refresh stale same-ID active context before the next provider request without duplicating current context. Confirmation/amendment decisions use session custom entries without full input text or inferred cancellation actors.
- Model mutations MUST be identity/status/control-generation guarded and check the amendment version supplied to their provider context, including inside the queued store mutation and NEVER mutate paused Goals or change budgets.
- Blocking MUST persist a trimmed nonempty reason and timestamp; leaving blocked MUST clear metadata. Legacy records without metadata remain readable.
- The blocked audit MUST exhaust authorized paths and repeat the same external-state or necessary unanswered-user impasse for ≥3 consecutive Goal turns. This is a floor, NEVER an attempt cap; live results/questions remain waits. Runtime MUST NOT claim semantic proof or universal wake-source observation.
- Storage MUST serialize whole mutations with Pi's native queue and publish atomically; one active Pi owner per session is the process-local concurrency boundary.
- Continuation MUST share identity/generation-safe single-flight admission; automatic continuation uses clean native pre-settlement boundaries, NEVER `agent_end` fresh runs.
- User cancellation MUST remain paused after final accounting, including over-budget usage. Completion usage and the one budget wrapup remain preserved.
- Objective prompts MUST treat Goal data as untrusted, preserve nonconflicting scope against newer input, and map verification evidence to each requirement.
- Goal display MUST use the QoL bridge when present; standalone footer is fallback only.
- Compact rendering MUST preserve model-visible result content.
- Fresh `/goal <objective>` identities MUST confirm with `Goal started` and the objective only, omitting duplicate status and zero usage. Inspection, completion, and same-identity objective-setting/resume MUST retain full usage and any existing budget; objective syntax does not set budgets.

- Goal tools MUST remain undeclared in fresh sessions until accepted ULW or explicit `/goal` activation. Restored unfinished Goals retain policy-permitted `get_goal`/`update_goal`; activation entries MUST match the current session identity.
- Goal owns the one-shot hidden ULW bootstrap: inspect first, use only the agreed task, preserve research/proposal scope, NEVER replace/resume unfinished Goals or infer budgets. Completed work requires a new task or explicit redo. Bootstrap context MUST expire after its run and NEVER replay from restored history.
- Goal always owns activation of its own tools per [Goal access](src/goal/access.ts), loaded under modes or standalone. Modes only gate permission over the activated set; they NEVER activate or deactivate Goal tools.

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
