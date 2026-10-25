## Purpose

Kua Fu's build-orchestrator prompt family.

## Ownership

- This document owns `mode.md`, `gpt.md`, `gemini.md`, the [gate-review](skills/gate-review/SKILL.md) skill, and family-local assets.

## Local Contracts

- Spoken intent is mandatory for every new user message, exactly once before tools; assistant/tool continuations within that user turn do not repeat it. The staged gate in [default](mode.md) and [GPT](gpt.md) separates lookup triggers, requested-outcome classification, authorization, and blocking ambiguity; [Gemini](gemini.md) follows the same steps.
- Variants MUST share one implementation authorization gate: active unfinished agreed work stays authorized across turns; explicit human Stop/pause/cancel suspends it, and a `STOPPED BY THE USER` worker is NEVER auto-resumed.
- Prompts MUST NOT restate harness mechanics owned by extensions.
- Kua Fu variants MUST pass checks by fixing code, never by loosening assertions, and MUST defer test keep/move/delete decisions to the `programming` skill's present-contract rule rather than restating it.
- `mode.md` and `gpt.md` routing ladders MUST list the same agents.
- Research-enabled handoffs follow the delegation-packet guidance in [mode.md](mode.md) and [gpt.md](gpt.md): distinguish supplied and assigned research from unresolved gaps while preserving recipient reasoning and personal-inspection duties. The [gate-review launch guidance](skills/gate-review/SKILL.md) applies the same boundary to both review axes.
- Verification and UI work sections in [mode.md](mode.md#verification-before-completion) and [gpt.md](gpt.md) (`# Done and verification`, `## UI work`) own fidelity checks, user-requested Huayan review, and parent integrated-QA/acceptance boundaries. Handoffs preserve the original request in the existing packet. UI handoffs distinguish user-pinned from open design decisions and leave design-skill routing to Yunu; mode prompts remain normally skill-aware without naming a particular design skill.
- The finish gate lives in [gate-review](skills/gate-review/SKILL.md) ([ADR 0006](../../docs/adr/0006-kuafu-finish-gate-uses-two-isolated-review-axes.md)): `direnjie` reviews Spec and `taishang` reviews Standards from [reviewer.md](skills/gate-review/reviewer.md); the orchestrator owns final acceptance.
- Follow the [parity rule](../MODEL-FAMILIES.md#parity-rule): author GPT instructions independently rather than translating `mode.md`. Shared-contract changes apply across variants; model-specific execution and communication tuning need not be copied to other families. Gemini remains a corrective overlay.

## Work Guidance

- In [default](mode.md) and [GPT](gpt.md), intent owns authorization, delegation owns assignment, supervision owns continuation, and verification owns evidence. Prefer general decision rules over task-specific cases unless needed.

- Authorization edits MUST read [default](mode.md) `Implementation authorization gate` + `Intent gate (every user message)`, [GPT](gpt.md) `# Authorization`, and [Gemini](gemini.md) `<KUAFU_INTENT_GATE>`; preserve variant agreement.
- GPT instruction-authority edits MUST read `# Instruction priority` + `# Authorization` in [gpt.md](gpt.md); preserve task-source handling and active-task continuity.
- GPT exploration, delegation, or supervision edits MUST read `# How to work` in [gpt.md](gpt.md) and `delegation_policy` + `supervision_continuity` in [mode.md](mode.md#delegation-policy); preserve the key triggers, explore rules, and Delegation Trust Rule, the do-it-yourself table, one-deliverable packets, the five packet fields, the UI loop, rejected approaches, and purposeful parallelism.
- GPT output-format or review-request edits MUST read `# Working with the user` and `# Hard rules` in [gpt.md](gpt.md).
- GPT scope edits MUST read `## Scope` in [gpt.md](gpt.md); preserve the unmet-requirement/failure-mode test, repair-versus-simplification comparison, and same-principal credential-transport boundary.
- GPT recovery or completion edits MUST read `# Done and verification` in [gpt.md](gpt.md); preserve single-owner checks, evidence reuse, one integration check, manual QA, the finish-gate trigger, recovery attempts, and stopping once the problem is solved.

## Verification

- Use the [shared mode checks](../AGENTS.md#verification) for family and runtime-sensitive changes.
- Routing ladder parity: `pnpm exec vitest run --project unit extensions/modes/test/kuafu-routing-parity.test.ts`.

## Child DOX Index

- None; this document owns the family assets.
