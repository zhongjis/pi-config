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
- [Hou Tu GPT](houtu/gpt.md) MUST follow user corrections immediately, gate Task/PLAN completion on independent verification, and require final user okay only for explicitly requested checkpoints. Default/Gemini contracts remain unchanged.
- Hou Tu GPT completion MUST cover remaining in-scope top-level tasks and F1-F4, excluding nested checkboxes; canceled PLAN tasks MUST remain `[-]` with existing Task mirrors `deleted`, NEVER completed.
- Hou Tu GPT MUST pass only the smallest task/verification-applicable skill set; `skills=[]` when none apply.

## Work Guidance

- You MUST audit final injected prompts, not source files alone.
- You MUST preserve [prompt audit requirements](../docs/specs/mode-prompt-audit-checklist.md).
- Prompt audits MUST preserve behavior unless a concrete issue or explicitly approved behavior change justifies alteration; deduplication MUST preserve mandated workflows.

## Verification

- Family coverage: `pnpm exec vitest run --project unit test/fuxi-clearance.test.ts`.
- Runtime-sensitive edits: `pnpm exec vitest run --project integration test/integration/modes.integration.test.ts`.

## Child DOX Index

- [fuxi/AGENTS.md](fuxi/AGENTS.md) — thin planner prompts and authoritative planning skill.
- [luban/AGENTS.md](luban/AGENTS.md) — skill-first prompts and pinned Superpowers snapshot.
