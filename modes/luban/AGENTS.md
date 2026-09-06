## Purpose

Lu Ban's skill-first mode prompts and local Superpowers skill snapshot.

## Ownership

- This document owns `mode.md`, `gpt.md`, `gemini.md`, and `skills/`.
- [UPSTREAM.md](UPSTREAM.md) pins the snapshot source, version, and commit.
- [LICENSE](LICENSE) carries the upstream MIT terms and attribution.
- This is a repository-local snapshot, not an external global skill installation.

## Local Contracts

- You MUST preserve the pinned snapshot's provenance and license notice.
- You MUST keep upstream skill material distinct from local mode adaptations.
- Snapshot refreshes MUST keep content and `UPSTREAM.md` aligned.
- Shared prompt construction follows [../README.md](../README.md).

## Work Guidance

- You MUST inspect local skill instructions before adapting their consumers.
- You SHOULD retain relative skill references within this snapshot.

## Verification

- Family coverage: `pnpm exec vitest run --project unit test/fuxi-clearance.test.ts`.
- Runtime mode coverage: `pnpm exec vitest run --project integration test/integration/modes.integration.test.ts`.

## Child DOX Index

- None; this document owns all local skills, provenance, and remaining files.
