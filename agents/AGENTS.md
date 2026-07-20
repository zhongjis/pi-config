# agents

## Purpose

Custom subagent definitions loaded by Pi. Files combine YAML frontmatter with prompt bodies.

## Ownership

This file owns all `agents/*.md` definitions.

## Local Contracts

- Keep mythology naming consistent with existing agents.
- Frontmatter controls routing: `display_name`, `description`, `model`, `builtin_tools`, `extension_tools`, `extensions`, `discover_skills`, and `preload_skills` must match the agent's intended capability.
- Match tool access to role scope. Read-only recon agents must not receive mutating tools.
- Prompt bodies define behavioral contracts; keep output formats explicit when callers depend on them.
- When an agent has `codegraph_*` and/or `lsp`, prompt tool guidance should distinguish CodeGraph for broad structure/impact, LSP for symbol-precise facts and diagnostics, and `rg`/`fd` for literal/file search.
- `yunu` is the frontend/web UI implementation and visual QA owner; keep its description explicit enough for orchestrators to choose it over generic implementation agents.
- `jintong` (sonnet, standard) and `juling` (opus, complex/higher-risk) are the two non-UI implementation tiers; keep their descriptions distinct so orchestrators route by task complexity.
- `taishang` is architecture/debugging consult + plan-compliance audit only (read-only, Oracle-aligned); it does NOT do code-quality review. No dedicated code-quality persona exists: the `orchestrator-owned code-quality gate` requires orchestrators to run checks and review diffs against requirements.
- `xuannv` is the callable tactical planning advisor. Keep it advisory, text-returning, separate from Fu Xi mode ceremony, and limited to read-only consultant delegation.

## Work Guidance

- Update the specific agent file when changing one agent's behavior.
- Preserve existing frontmatter keys unless intentionally changing runtime routing.
- When adding an agent, use one `agents/<name>.md` file and give it a unique, task-oriented description.
- Avoid broad prompt rewrites unless the agent role itself changes.

## Verification

- Re-read changed frontmatter and prompt body for internal consistency.
- No repo-local automated check validates agent markdown; if runtime behavior matters, test by launching that agent through the `Agent` tool.

## Child DOX Index

No child `AGENTS.md` files. This file owns every `agents/*.md` file.
