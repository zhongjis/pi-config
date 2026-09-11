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
- Pause/resume remain user-controlled; tool completion/blocking follows [README tool contracts](README.md#tools).
- Goal display MUST use the QoL bridge when present; standalone footer is fallback only.
- Compact rendering MUST preserve model-visible result content.

## Work Guidance

- You MUST preserve [pinned upstream provenance](README.md#upstream) and [LICENSE](LICENSE).
- [README Local Additions](README.md#local-additions) describes rendering and footer integration deltas.
- Accounting and footer changes SHOULD remain separate concerns.

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/goal/test`.
- [Continuation](test/continuation.test.ts), [store](test/store.test.ts), and [footer bridge](test/footer-bridge.test.ts) provide focused coverage.

## Child DOX Index

- None; this document owns the entire subtree.
