## Purpose

Own the harness's consolidated session UI and built-in write presentation.

## Ownership

- Owns startup header, shared footer, prompt URL widget, session/exit commands, and over-limit compaction guard.
- Goal, LSP, and subagents supply status/accounting through existing bridge contracts.

## Local Contracts

- QoL owns the single footer slot; bridge symbols MUST remain compatible.
- Goal accounting stays in goal; QoL consumes its indicator only.
- Over-limit compaction MUST wait for native retry/auto-compaction settlement.
- Only one manual compaction request may be pending; queued continuation work takes precedence.
- Write presentation MUST preserve native metadata and all five execution arguments.
- Expanded write output MUST show exact raw built-in output.

## Work Guidance

- [README](README.md) owns footer symbols, lifecycle hooks, and command behavior.
- Presentation changes MUST NOT alter model-visible results or native write behavior.
- Startup header configuration SHOULD avoid duplicate default resource listings.

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/qol/test`.
- [Footer bridge](test/footer-goal.test.ts), [compaction](test/context-compaction.test.ts), and [write rendering](test/write-tool-renderer.test.ts) cover ownership and parity.

## Child DOX Index

- None; this document owns the entire subtree.
