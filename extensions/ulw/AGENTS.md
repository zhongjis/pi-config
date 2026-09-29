## Purpose

Inject the opt-in ultrawork prompt in Kua Fu mode when a message contains `ultrawork` or `ulw`.

## Ownership

- Owns keyword detection, model-family prompt selection, prompt variants, the activation banner, and tests.
- [README](README.md) owns hooks and upstream adaptation.

## Local Contracts

- ULW is intentionally high-rigor opt-in: `prompts/gpt.md` MUST preserve automatic planning, deep parallel research, strict verification, and scoped self-correction under active mode policy; GPT-specific refinements do not change the default variant.
- ULW GPT MUST respect proposal-only scope and planner approval/handoff gates; research tracks follow distinct factual gaps, not mandatory lane counts.
- ULW GPT scenario evidence MUST follow distinct failure modes; combinations require concrete interaction risks. Mocked results prove caller handling only; existing evidence MAY serve multiple scenarios without bespoke reporting.

## Work Guidance

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/ulw`.

## Child DOX Index

- None; this document owns the entire subtree.
