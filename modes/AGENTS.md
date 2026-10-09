## Purpose

Mode Agent prompts, model-family variants, and active-mode skills.

## Ownership

- [README.md](README.md) owns prompt construction.
- This document owns shared mode docs and runtime links.
- Children own their family prompts, variants, skills, and supporting assets.
- The active mode set is `kuafu`, `fuxi`, and `houtu`.
- Runtime discovery and switching belong to [../extensions/modes/](../extensions/modes/).

## Local Contracts

- You MUST follow [frontmatter semantics](../docs/guides/agent-frontmatter.md).
- `mode.md` supplies frontmatter and the default body.
- Kua Fu/Hou Tu `tools:` MUST grant `imagegen`; Fu Xi MUST NOT: generation writes files and spends subscription quota.
- Mode `tools:` MUST start from `+@all` and subtract only tools the model can reach on its own. MUST NOT subtract command-gated tools, which an extension activates only from a user command.
- Kua Fu/Hou Tu `tools:` MUST grant `agent_graph`, `get_agent_result`, and `resolve_agent_graph_gate`; Fu Xi MUST NOT grant `agent_graph` or `resolve_agent_graph_gate`. Existing delegation and role restrictions still apply.
- Kua Fu/Hou Tu MUST allow `wenchang`, `chengfeng` and `simaqian` delegation so saved agent graphs that use them pass graph delegation preflight.
- Mode model fallback chains MUST use `cliproxyapi` instead of `openai-codex` for Codex models.
- `gpt.md` replaces only the body; it MUST be self-contained.
- Absent GPT variants inherit the default body.
- `gemini.md` is a body-only corrective overlay on the default.
- Kua Fu/Hou Tu default, GPT, and Gemini routing prose MUST match model-visible descriptions in `agents/*.md`.
- Preserve the general/complex worker distinction owned by [Jintong](../agents/jintong.md) and [Juling](../agents/juling.md) across both families; their prompts own the evidence-based routing boundary.
- Kua Fu/Hou Tu MAY delegate standalone prose to Cangjie; Fu Xi owns plan prose and MUST NOT delegate to Cangjie.
- Runtime discovers only the active mode's existing skills; bodies load on demand.
- Kua Fu/Hou Tu families MUST assign workers focused regression and file-local lint/format; parent owns package/global integration after relevant writers finish. Checks sharing mutable databases MUST NOT overlap without established isolation.
- Parent MUST read changed files, review the full applicable diff, and inspect actual command/scope/output/exit status, NEVER summaries alone. Evidence is reusable only while relevant source/dependencies/configuration/environment/external state remain valid.
- Parent MUST obtain appropriate final executable integration evidence for combined changes; worker passes alone are insufficient. Outside Kua Fu GPT recovery, run missing, invalidated, diagnostic, or explicitly required checks, NEVER delegation/phase-only repetitions; repairs invalidate affected previously passing checks.
- Parent QA MUST cover changed user-visible surfaces and affected interactions; valid parent QA/integration evidence MAY be reused.
- Future push hooks MUST NOT approve earlier completion; verification NEVER authorizes pushing.

## Work Guidance

- You MUST audit final injected prompts, not source files alone.
- You MUST preserve [prompt audit requirements](../docs/specs/mode-prompt-audit-checklist.md).
- Prompt audits MUST preserve behavior unless a concrete issue or explicitly approved behavior change justifies alteration; deduplication MUST preserve mandated workflows.

## Verification

- Family coverage: `pnpm exec vitest run --project unit extensions/modes/test/config-loader.test.ts`.
- Runtime-sensitive edits: `pnpm exec vitest run --project integration test/integration/modes.integration.test.ts`.

## Child DOX Index

- [fuxi/AGENTS.md](fuxi/AGENTS.md) — thin planner prompts and authoritative planning skill.
- [kuafu/AGENTS.md](kuafu/AGENTS.md) — build-orchestrator family maintenance and authorization contracts.
- [houtu/AGENTS.md](houtu/AGENTS.md) — approved-plan execution family maintenance and completion gates.
