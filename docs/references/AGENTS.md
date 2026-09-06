## Purpose

Citable evidence, session records, and upstream reference snapshots.

## Ownership

- This document owns loose reference files and the `oh-my-openagent/` subtree.
- [Oh My OpenAgent README](oh-my-openagent/README.md) owns archive refresh and provenance details.
- Active planner policy belongs to [ulw-plan](../../modes/fuxi/skills/ulw-plan/SKILL.md), not this archive.

## Local Contracts

- References are evidence, never policy.
- You MUST preserve snapshot source, revision, and license provenance.
- You MUST distinguish generated upstream prompts from locally adapted runtime instructions.
- You MUST regenerate archived final prompts; MUST NOT hand-edit generated files.
- Session records and plans here are historical evidence, not active instructions.

## Work Guidance

- You MUST follow the archive README for refreshes and reuse constraints.
- You SHOULD cite pinned evidence rather than implying current upstream behavior.

## Verification

- Archive comparison: `pnpm check:oh-my-openagent-prompts`.
- This check fetches pinned upstream dependencies and compares temporary output without replacing the archive.
- Offline helper coverage: `pnpm exec vitest run --project unit test/oh-my-openagent-final-prompts.test.ts`.

## Child DOX Index

- None; this document owns all reference subdirectories and remaining files.
