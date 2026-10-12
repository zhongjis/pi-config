## Purpose

Kua Fu's build-orchestrator prompt family.

## Ownership

- This document owns `mode.md`, `gpt.md`, `gemini.md`, the [gate-review](skills/gate-review/SKILL.md) skill, and family-local assets.

## Local Contracts

- Variants MUST share one implementation authorization gate: active unfinished agreed work stays authorized across turns; explicit human Stop/pause/cancel suspends it, and a `STOPPED BY THE USER` worker is NEVER auto-resumed.
- Prompts MUST NOT restate harness mechanics owned by extensions.
- Kua Fu variants MUST pass checks by fixing code, never by loosening assertions, and MUST defer test keep/move/delete decisions to the `programming` skill's present-contract rule rather than restating it.
- `mode.md` and `gpt.md` routing ladders MUST list the same agents.
- Verification and UI work sections in [mode.md](mode.md#verification-before-completion) and [gpt.md](gpt.md) (`# Done and verification`, `## UI work`) own fidelity checks, user-requested Huayan review, and parent-QA/acceptance boundaries.
- The finish gate lives in [gate-review](skills/gate-review/SKILL.md) ([ADR 0006](../../docs/adr/0006-kuafu-finish-gate-uses-two-isolated-review-axes.md)): `direnjie` reviews Spec and `taishang` reviews Standards from [reviewer.md](skills/gate-review/reviewer.md); the orchestrator owns final acceptance.
- Per the [parity rule](../MODEL-FAMILIES.md#parity-rule), `mode.md` is canonical for behavior. `gpt.md` restates it in Codex-style Markdown with absolute rules in `# Hard rules`, and its `# Habits to counter` names the [documented GPT overwork habits](../MODEL-FAMILIES.md#local-addition-gpt-overwork-habits). `gemini.md` corrects quirks only. Behavior changes land in `mode.md` and every variant together.

## Work Guidance

- In [default](mode.md) and [GPT](gpt.md), intent owns authorization, delegation owns assignment, supervision owns continuation, and verification owns evidence. Prefer general decision rules over task-specific cases unless needed.

- Authorization edits MUST read [default](mode.md) `Implementation authorization gate` + `Intent gate (every message)`, [GPT](gpt.md) `# Authorization`, and [Gemini](gemini.md) `<KUAFU_INTENT_GATE>`; preserve variant agreement.
- GPT instruction-authority edits MUST read `# Instruction priority` + `# Authorization` in [gpt.md](gpt.md); preserve task-source handling and active-task continuity.
- GPT exploration, delegation, or supervision edits MUST read `# How to work` in [gpt.md](gpt.md) and `delegation_policy` + `supervision_continuity` in [mode.md](mode.md#delegation-policy); preserve direct small lookups, the do-it-yourself table, one-deliverable packets, the five packet fields, the UI loop, rejected approaches, and purposeful parallelism.
- GPT output-format or review-request edits MUST read `# Working with the user` and `# Hard rules` in [gpt.md](gpt.md).
- GPT scope edits MUST read `## Scope` in [gpt.md](gpt.md); preserve the unmet-requirement/failure-mode test, repair-versus-simplification comparison, and same-principal credential-transport boundary.
- GPT recovery or completion edits MUST read `# Done and verification` in [gpt.md](gpt.md); preserve single-owner checks, evidence reuse, one integration check, manual QA, the finish-gate trigger, recovery attempts, and stopping once the problem is solved.

## Verification

- Use the [shared mode checks](../AGENTS.md#verification) for family and runtime-sensitive changes.
- Routing ladder parity: `pnpm exec vitest run --project unit extensions/modes/test/kuafu-routing-parity.test.ts`.

## Child DOX Index

- None; this document owns the family assets.
