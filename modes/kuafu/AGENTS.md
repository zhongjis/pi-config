## Purpose

Kua Fu's build-orchestrator prompt family.

## Ownership

- This document owns `default.md`, `gpt.md`, `gemini.md`, the [gate-review](skills/gate-review/SKILL.md) skill, and family-local assets.

## Local Contracts

- Spoken intent is mandatory for every new user message, exactly once before tools; assistant/tool continuations within that user turn do not repeat it. The staged gate in [default](default.md) and [GPT](gpt.md) separates lookup triggers, requested-outcome classification, authorization, and blocking ambiguity; [Gemini](gemini.md) follows the same steps.
- Variants MUST share one turn-local implementation authorization gate: the current message must request a change, approve the previous proposal, or resume named earlier work; a question or doubt about in-progress work authorizes no new edits, while running workers continue; explicit human Stop/pause/cancel suspends work, and a `STOPPED BY THE USER` worker is NEVER auto-resumed.
- Prompts MUST NOT restate harness mechanics owned by extensions.
- Kua Fu variants MUST pass checks by fixing code, never by loosening assertions, and MUST defer test keep/move/delete decisions to the `programming` skill's present-contract rule rather than restating it.
- `default.md` and `gpt.md` routing ladders MUST list the same agents.
- Research-enabled handoffs follow the delegation-packet guidance in [default.md](default.md) and [gpt.md](gpt.md): distinguish supplied and assigned research from unresolved gaps while preserving recipient reasoning and personal-inspection duties. The [gate-review launch guidance](skills/gate-review/SKILL.md) applies the same boundary to both review axes.
- Verification and UI work sections in [default.md](default.md#verification-before-completion) and [gpt.md](gpt.md) (`# Done and verification`, `## UI work`) own fidelity checks, user-requested Huayan review, and parent integrated-QA/acceptance boundaries. Handoffs preserve the original request in the existing packet. UI handoffs distinguish user-pinned from open design decisions and leave design-skill routing to Yunu; mode prompts remain normally skill-aware without naming a particular design skill.
- The finish gate lives in [gate-review](skills/gate-review/SKILL.md) ([ADR 0006](../../docs/adr/0006-kuafu-finish-gate-uses-two-isolated-review-axes.md)): `direnjie` reviews Spec and `taishang` reviews Standards from [reviewer.md](skills/gate-review/reviewer.md); the orchestrator owns final acceptance.
- Follow the [parity rule](../MODEL-FAMILIES.md#parity-rule): author GPT instructions independently rather than translating `default.md`. Shared-contract changes apply across variants; model-specific execution and communication tuning need not be copied to other families. Gemini remains a corrective overlay.

## Verification

- Use the [shared mode checks](../AGENTS.md#verification) for family and runtime-sensitive changes.

## Child DOX Index

- None; this document owns the family assets.
