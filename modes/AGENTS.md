## Purpose

Mode Agent prompts, model-family variants, and active-mode skills.

## Ownership

- [README.md](README.md) owns prompt construction and the current family matrix.
- This document owns shared mode docs and `houtu/`, `kuafu/`, `shennong/`, `zhurong/`.
- Fu Xi and Lu Ban children own their prompts and local skills.
- Runtime discovery and switching belong to [../extensions/modes/](../extensions/modes/).

## Local Contracts

- You MUST follow [frontmatter semantics](../docs/guides/agent-frontmatter.md).
- `mode.md` supplies frontmatter and the default body.
- `gpt.md` replaces only the body; it MUST be self-contained.
- Absent GPT variants inherit the default body.
- `gemini.md` is a body-only corrective overlay on the default.
- Runtime discovers only the active mode's existing skills; bodies load on demand.

## Work Guidance

- You MUST audit final injected prompts, not source files alone.
- You MUST preserve [prompt audit requirements](../docs/specs/mode-prompt-audit-checklist.md).

## Verification

- Family coverage: `pnpm exec vitest run --project unit test/fuxi-clearance.test.ts`.
- Runtime-sensitive edits: `pnpm exec vitest run --project integration test/integration/modes.integration.test.ts`.

## Child DOX Index

- [fuxi/AGENTS.md](fuxi/AGENTS.md) — thin planner prompts and authoritative planning skill.
- [luban/AGENTS.md](luban/AGENTS.md) — skill-first prompts and pinned Superpowers snapshot.
