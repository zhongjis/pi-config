## Purpose

Inject the opt-in ultrawork prompt in Kua Fu mode when a message contains `ultrawork` or `ulw`.

## Ownership

- Owns keyword detection, model-family prompt selection, prompt variants, the activation banner, and tests.
- [README](README.md) owns upstream adaptation; [index.ts](index.ts) owns hooks.

## Local Contracts

- Both prompt variants MUST preserve high-rigor opt-in under active mode policy: invoke advisory xuannv planning for design uncertainty remaining after relevant research, not step/file counts; require evidence-bearing workers while the orchestrator owns full-task acceptance.
- Both variants MUST stop redundant work once useful evidence satisfies the request, without waiving required final-state checks, manual QA, or approval/handoff gates. Deep parallel research, strict verification, and scoped self-correction remain required.
- ULW GPT MUST respect proposal-only scope and planner approval/handoff gates; research tracks follow distinct factual gaps, not mandatory lane counts.
- ULW GPT scenario evidence MUST follow distinct failure modes; combinations require concrete interaction risks. Mocked results prove caller handling only; existing evidence MAY serve multiple scenarios without bespoke reporting.

## Work Guidance

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/ulw`.

## Child DOX Index

- None; this document owns the entire subtree.
