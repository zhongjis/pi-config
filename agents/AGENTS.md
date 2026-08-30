# agents

## Purpose

Custom subagent definitions loaded by Pi. Files combine YAML frontmatter with prompt bodies.

## Ownership

This file owns all `agents/*.md` definitions.

## Local Contracts

- Keep mythology naming consistent with existing agents.
- Frontmatter `description` owns selector eligibility; keep it selector-complete.
- Orchestrator prompts own detailed routing and escalation policy.
- Worker bodies own post-selection execution behavior.
- Match tool access to role scope. Read-only recon agents must not receive mutating tools.
- Other frontmatter controls capability: `display_name`, `model`, `builtin_tools`, `extension_tools`, `extensions`, `discover_skills`, and `preload_skills` must match the intended role.
- Every enabled agent excludes parent/session-only extensions: `ulw`, `caveman`, `smart-sessions`, `boomerang`, `inline-skills`, and `goal`; keep `direnv` available.
- When an agent has `codegraph_*` and/or `lsp`, prompt tool guidance should distinguish CodeGraph for broad structure/impact, LSP for symbol-precise facts and diagnostics, and `rg`/`fd` for literal/file search.
- `yunu` is the frontend/web UI implementation owner (implementation only; visual/browser QA stays with the orchestrator's Manual QA Gate, matching omo's `visual-engineering` category); keep its description explicit enough for orchestrators to choose it over generic implementation agents.
- `taishang` is architecture/debugging consult + plan-compliance audit only (read-only, Oracle-aligned); it does NOT do code-quality review. No dedicated code-quality persona exists: the `orchestrator-owned code-quality gate` requires orchestrators to run checks and review diffs against requirements.
- `xuannv` is the callable tactical planning advisor. Its description and body expose coarsest-cohesive planning plus advisory Worker fit and Escalation triggers evidence. Keep it text-returning, separate from Fu Xi ceremony, and limited to read-only consultant delegation.
- Upstream lineage: each agent maps to an Oh My OpenAgent persona or task category. The accepted mapping baseline and provenance live in [`docs/specs/mode-prompt-parity.md`](../docs/specs/mode-prompt-parity.md); per-agent lineage is also noted inline in each agent's `<role>`. Do not duplicate the mapping table here.

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
