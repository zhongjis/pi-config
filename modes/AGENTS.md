# modes

## Purpose

Mode prompt definitions and model-family prompt variants for Kua Fu, Fu Xi, Hou Tu, Lu Ban, and Shen Nong.

## Ownership

This file owns `modes/` prompt files and mode subdirectories.

## Local Contracts

- `mode.md` carries canonical frontmatter plus default prompt body.
- `gpt.md` is a body-only replacement; it inherits `mode.md` frontmatter and must be self-contained.
- `gemini.md` is a body-only corrective overlay on the default prompt body.
- Keep the per-mode file matrix (`mode.md` + `gpt.md` + `gemini.md`) complete unless intentionally removing a mode family.
- `<mode>/skills/*/SKILL.md` (optional): mode-scoped skills discovered only while that mode is active. Context bootstrap is separate and must be configured explicitly; references resolve relative to the skill base dir supplied at runtime.
- Fu Xi is a thin Prometheus prompt family. `modes/fuxi/mode.md`, `gpt.md`, and `gemini.md` stay light; active planning policy lives in preloaded `modes/fuxi/skills/ulw-plan/SKILL.md` plus `modes/fuxi/skills/ulw-plan/references/*`, injected by runtime. The `ulw-plan` skill is authoritative for Fu Xi’s exactly seven planning stages; do not duplicate the stage text here.
- Oh My OpenAgent final prompt archive lives at `docs/references/oh-my-openagent/final-prompts/`; refresh with `pnpm sync:oh-my-openagent-prompts`, verify with `pnpm check:oh-my-openagent-prompts`, and never hand-edit generated prompts.
- Lu Ban owns the 14-skill Superpowers snapshot under `modes/luban/skills/`; `UPSTREAM.md` and `LICENSE` preserve provenance. Runtime discovery is Luban-only, with no eager context bootstrap.
- Kuafu delegates turn-local tactical planning to callable `xuannv`; keep that advisory text-return flow separate from Fu Xi mode’s durable planning ceremony.
- Preserve locked family anchors in prompt variants (`mode.md`, `gpt.md`, `gemini.md`) and keep prompt audits focused on the final injected session prompt, including the final injected session audit requirement.
- When mode prompts mention code intelligence, preserve the split: CodeGraph for broad structure/impact, LSP for symbol-precise facts and diagnostics, `rg`/`fd` for literal/file search.
- For orchestration modes, keep delegation chunks worker-sized: one domain, one deliverable, sized to one worker session; split state/API/UI/tests/docs/git by domain or coupling, not by a fixed file count. A plan item too large for one session runs as one resumable worker session (staging, a green checkpoint, a tool-call ceiling, and a fail-safe — stop at last green state, report a resume anchor, never leave the tree broken) resumed in place with `Agent(resume)`, never carved into separate delegations. Workers stop and ask only when a task is genuinely ambiguous; they never reject on file count.
- Frontend/web UI implementation, styling, layout, components, visual behavior, and browser QA route to `yunu`; keep `jintong` as the standard non-UI implementation/debug/test worker and `juling` as the opus-tier worker for complex/higher-risk implementation.
- Code-quality review (build/lint/typecheck/tests + diff-vs-requirements) is an `orchestrator-owned code-quality gate`; `taishang` is architecture/debugging consult + F1 plan-compliance audit only, NEVER code-quality review (realigned to omo's Oracle, which does not review code).
- Hou Tu executes `local://PLAN.md` with strict lifecycle separation. Pi-tasks are logical DAG tracking only: `TaskCreate` one task per top-level plan item, wire dependencies with `TaskUpdate addBlockedBy`, mark `in_progress` before delegation, and mark `completed` only after Hou Tu independently verifies evidence. Use pi-tasks for logical tracking; use Agent/get_subagent_result/steer_subagent for agent lifecycle. Plan work runs directly through `Agent`; supervision uses `get_subagent_result`/`steer_subagent`, with `Agent(resume)` for salvageable workstreams. Hou Tu never stores agent IDs/runtime state in task owner/metadata. Independent tasks launch as separate background agents; task status and PLAN checkboxes remain the authoritative verified-work state.
- Fu Xi emits a per-task `Recommended Max Turns` advisory. Hou Tu uses it when sizing direct `Agent` runs and may raise it; workers remain bounded by one domain and one deliverable.
- Delegation frontmatter is canonically parsed into a versioned policy snapshot persisted in `agent-mode` state. `subagent` consumes that snapshot as authorization authority for direct `Agent` and RPC requests; modes hooks retain non-`Agent` guards only, while static `Agent` guidance stays generic and non-stale.

## Work Guidance

- Change the narrowest prompt variant that matches the target model family.
- Preserve frontmatter in `mode.md` unless changing runtime mode registration.
- Keep model-family overrides aligned in intent, even when wording differs.
- Use `docs/specs/mode-prompt-audit-checklist.md` for broad prompt audits.

## Verification

- Re-read the final edited prompt variant and its corresponding `mode.md`.
- For runtime-sensitive changes, run the relevant integration coverage from root with `pnpm test:integration` or the focused mode integration test when available.

## Child DOX Index

| Path | Owner Doc | Scope |
|------|-----------|-------|
| `fuxi/` | this file | Fu Xi planning mode prompt variants. |
| `houtu/` | this file | Hou Tu execution mode prompt variants. |
| `kuafu/` | this file | Kua Fu build-orchestrator mode prompt variants. |
| `luban/` | this file | Lu Ban prompt variants, mode-owned Superpowers skill snapshot, and provenance. |
| `shennong/` | this file | Shen Nong product-manager mode prompt variants. |
