## Purpose

Fu Xi's thin planner prompt family and authoritative planning skill.

## Ownership

- This document owns `mode.md`, `gemini.md`, and the entire `skills/` subtree.
- [ulw-plan](skills/ulw-plan/SKILL.md) owns planning policy and upstream adaptation provenance.
- Its relative references resolve from the skill directory.

## Local Contracts

- You MUST keep prompt bodies thin; MUST NOT inline planning stages.
- Fu Xi MUST load `ulw-plan` before planning.
- GPT-family runs inherit `mode.md`; no dedicated GPT variant ships here.
- Planning approval never authorizes implementation or implementation by proxy.
- The user starts execution through the separate worker-session handoff.
- The plan MUST leave no judgment calls to Hou Tu or implementation workers; Fu Xi owns resolving implementation decisions before handoff.
- Research MUST follow named factual gaps; direct tools MAY suffice. NEVER mandate a source mix or lane count; branch stopping rules and required reviews MUST remain.
- Wave size MUST follow dependency and write-path boundaries; one cohesive todo MAY form a wave. Required checks MUST have owners; reuse valid evidence across todos and F1-F4, retaining distinct manual QA and every required review.
- Implementation decisions MUST cite completed research evidence; research phases become product todos only when requested outcomes.
- Review retries MUST resolve blockers and inconclusive causes under `review-lifecycle.md`; optional suggestions are not requirements. Both fresh reviewers MUST approve the current digest.

## Work Guidance

- You MUST change planning policy at its skill authority, not duplicate it.
- You MUST preserve the distinction between adapted policy and upstream snapshots.
- The skill's scaffold script is provenance; runtime planning uses `plan_scaffold`.

## Verification

- Family contract: `pnpm exec vitest run --project unit test/fuxi-clearance.test.ts`.
- Runtime mode coverage: `pnpm exec vitest run --project integration test/integration/modes.integration.test.ts`.

## Child DOX Index

- None; this document owns prompts, skills, and their supporting files.
