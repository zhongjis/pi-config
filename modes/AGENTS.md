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
- [Hou Tu GPT](houtu/gpt.md) MUST follow user corrections immediately, gate Task/PLAN completion on independent verification, and require final user okay only for explicitly requested checkpoints. Default/Gemini retain their final user-okay requirement.
- Hou Tu GPT completion MUST cover remaining in-scope top-level tasks and F1-F4, excluding nested checkboxes; canceled PLAN tasks MUST remain `[-]` with existing Task mirrors `deleted`, NEVER completed.
- Hou Tu GPT MUST pass only the smallest task/verification-applicable skill set; `skills=[]` when none apply.
- Kua Fu/Hou Tu families MUST assign workers focused regression and file-local lint/format; parent owns package/global integration after relevant writers finish. Checks sharing mutable databases MUST NOT overlap without established isolation.
- Parent MUST read changed files, review the full applicable diff, and inspect actual command/scope/output/exit status, NEVER summaries alone. Evidence is reusable only while relevant source/dependencies/configuration/environment/external state remain valid.
- Parent MUST obtain appropriate final executable integration evidence for combined changes; worker passes alone are insufficient. Outside Kua Fu GPT recovery, run missing, invalidated, diagnostic, or explicitly required checks, NEVER delegation/phase-only repetitions; repairs invalidate affected previously passing checks.
- Kua Fu GPT MUST require current-message edit authorization, limit bug fixes to the smallest concrete fix, and re-run only failed focused checks during recovery; evidence-validity completion gates remain.
- Parent QA MUST cover changed user-visible surfaces and affected interactions; valid parent QA/integration evidence MAY be reused. Hou Tu retains F1=`taishang`, F2=parent code-quality/integration, F3=parent QA, F4=`direnjie`.
- Future push hooks MUST NOT approve earlier completion; verification NEVER authorizes pushing.

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
