## Purpose

Kua Fu's build-orchestrator prompt family.

## Ownership

- This document owns `mode.md`, `gpt.md`, `gemini.md`, and family-local assets.

## Local Contracts

- Variants MUST share one implementation authorization gate: active unfinished agreed work stays authorized across turns; explicit human Stop/pause/cancel suspends it, and a `STOPPED BY THE USER` worker is NEVER auto-resumed.
- Prompts MUST NOT restate harness mechanics owned by extensions.
- Kua Fu variants MUST pass checks by fixing code, never by loosening assertions, and MUST defer test keep/move/delete decisions to the `programming` skill's present-contract rule rather than restating it.
- `mode.md` and `gpt.md` routing ladders MUST list the same agents; the default body runs most sessions, so routing fixes land in both.

## Work Guidance

- Authorization edits MUST read [default](mode.md) `Implementation authorization gate` + `Intent gate (every message)`, [GPT](gpt.md) `<intent_gate>`, and [Gemini](gemini.md) `<KUAFU_INTENT_GATE>`; preserve variant agreement.
- GPT instruction-authority or clarification edits MUST read `<instruction_priority>` + `<intent_gate>` in [gpt.md](gpt.md); preserve task-source handling and active-task continuity.
- GPT exploration or tool-batching edits MUST read `<execution_loop>` in [gpt.md](gpt.md); preserve reconnaissance routing, bounded direct lookups, and conditional parallel batching.
- GPT review, output-format, or error-handling edits MUST read `<tool_use_policy>`, `<communication>`, and `<hard_invariants>` in [gpt.md](gpt.md).
- GPT delegation edits MUST read `<delegation_policy>` in [gpt.md](gpt.md); preserve packet authority, accepted outcomes/exclusions, acceptance criteria, rejected approaches, coverage reuse, mechanics constraints, and purposeful parallelism.
- GPT additions MUST read `<scope_discipline>` in [gpt.md](gpt.md); preserve the unmet-requirement/failure-mode test, repair-versus-simplification comparison, and same-principal credential-transport boundary.
- GPT recovery or completion edits MUST read `<execution_loop>`, `<recovery_policy>`, and `<verification>` in [gpt.md](gpt.md); preserve smallest concrete fixes, failed-focused-check recovery, evidence-validity gates, risk-proportional verification, blocked-exit evidence/resume action, and stopping after acceptance.

## Verification

- Use the [shared mode checks](../AGENTS.md#verification) for family and runtime-sensitive changes.
- Routing ladder parity: `pnpm exec vitest run --project unit extensions/modes/test/kuafu-routing-parity.test.ts`.

## Child DOX Index

- None; this document owns the family assets.
