## Purpose

Inject the opt-in ultrawork prompt in Kua Fu mode when a message contains a bare `ultrawork` or `ulw` token.

## Ownership

- Owns keyword detection, model-family prompt selection, prompt variants, the activation banner, and tests.
- [README](README.md) owns upstream adaptation; [index.ts](index.ts) owns hooks.

## Local Contracts

- Explicit activation MUST require a bare `ulw` or `ultrawork` token anywhere in input, case-insensitive, bounded by whitespace or start/end. Task-prefixed and mid-message tokens activate; quoted, path, and punctuation-attached tokens do not. Preserve code/prompt/`@` reference sanitation, kuafu gating, pending-flag consumption, and separate custom-message injection; task-bearing user text remains unchanged.

- Both prompt variants MUST preserve high-rigor opt-in under active mode policy: invoke advisory xuannv planning for design uncertainty remaining after relevant research, not step/file counts; require evidence-bearing workers while the orchestrator owns full-task acceptance.
- Both variants MUST stop redundant work once useful evidence satisfies the request, without waiving required final-state checks, manual QA, or approval/handoff gates. Deep parallel research, strict verification, and scoped self-correction remain required.
- ULW GPT MUST respect proposal-only scope and planner approval/handoff gates; research tracks follow distinct factual gaps, not mandatory lane counts.
- Both variants MUST consider happy-path, relevant boundary/failure, and affected adjacent-caller behavior; select scenarios for concrete risks without fixed minimum, category quotas, or filler. Combinations require concrete interaction risks. Mocked results prove caller handling only; existing evidence MAY serve multiple scenarios without bespoke reporting.
- Both variants MUST use the cheapest existing checks sufficient for affected contracts and coupling risks under their inline Testing Policy: read covering tests, establish relevant baselines, reproduce bugs, and add tests only where repository convention keeps them and regressions would otherwise go unnoticed. Required repository gates and manual QA for runnable changed user surfaces remain binding.
- Refactors MUST compare relevant pre-change/post-change results to prove preservation, distinguishing pre-existing from new failures; characterization is only for uncovered behavior at an existing test seam. Missed necessary baselines MUST be recovered in isolation, NEVER discard user/concurrent changes or misrepresent chronology. Pre-existing failures do not waive preservation evidence; missing required evidence or unresolved change-caused failures block acceptance.
- You MUST review prompt prose rather than assert it; tests MAY protect machine-consumed contracts with synthetic mechanism fixtures, NEVER pin live repository data. Reuse evidence until relevant changes invalidate it.

- Accepted activation MUST emit one session-scoped `ulw:activated` signal; ULW NEVER reads or mutates Goal state. Goal owns the separate hidden bootstrap and lifecycle. Session switching MUST discard pending injection.

## Work Guidance

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/ulw`.

## Child DOX Index

- None; this document owns the entire subtree.
