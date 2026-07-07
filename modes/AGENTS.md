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
- `<mode>/references/*.md` (optional): on-demand depth the mode body loads with `read` at the absolute mode-dir path `~/.pi/agent/modes/<mode>/references/…` (that dir symlinks to repo `modes/`, so references resolve in any cwd). Fu Xi uses this reference-split: a thin always-loaded router in `mode.md`/`gpt.md`/`gemini.md` plus `references/{intent-clear,intent-unclear,full-workflow}.md`. Keep the router's MUST-read directive and the references in sync. Test-locked strings (the Phase-2 plan ceremony, gemini overlay tags, `ADVISORY SUBPLAN MODE` in `mode.md`-only) MUST stay in the router files, not the references — `test/fuxi-clearance.test.ts` asserts them.
- Prompt audits must inspect the final injected prompt, not only source fragments.
- When mode prompts mention code intelligence, preserve the split: CodeGraph for broad structure/impact, LSP for symbol-precise facts and diagnostics, `rg`/`fd` for literal/file search.
- For orchestration modes, keep delegation chunks worker-sized: one domain, one deliverable, usually ≤3 expected product files; split state/API/UI/tests/docs/git unless tightly coupled. A task kept whole under that coupling exception must still be recoverable: staging, a green checkpoint, a tool-call ceiling, and a fail-safe (stop at last green state, report a resume anchor, never leave the tree broken).
- Frontend/web UI implementation, styling, layout, components, visual behavior, and browser QA route to `yunu`; keep `jintong` as the non-UI implementation/debug/test worker.
- Hou Tu executes `local://PLAN.md` as a per-task pi-task DAG, not per-wave: `TaskCreate` one pi-task per top-level plan task (agentType from the plan `Agent:` field, 7-section contract in `description`), wire deps with `TaskUpdate addBlockedBy`, run via `TaskExecute` (never raw `Agent()` for plan work; `additional_context` is batch-shared so per-task context stays in `description`). This couples Hou Tu to the `tasks` extension: a pi-task `completed` means the agent stopped (self-report OR interrupted), NOT verified — only a `PLAN.md` checkbox flips after Hou Tu's evidence. Retries re-run fresh via `TaskExecute` (re-open with `TaskUpdate status:pending`), never `Agent(resume)`. `autoCascade` stays OFF so Hou Tu is the QA gate between tasks. The houtu invariant "One TaskExecute launch = one bounded plan task" is asserted in `test/fuxi-clearance.test.ts`.
- Fu Xi emits a per-task `Recommended Max Turns` (advisory) in the plan; Hou Tu uses it as the starting `max_turns` and may raise it. It is the executor's only cost/runaway guard (no token/compaction cap exists in the subagent spawn API).

## Work Guidance

- Change the narrowest prompt variant that matches the target model family.
- Preserve frontmatter in `mode.md` unless changing runtime mode registration.
- Keep model-family overrides aligned in intent, even when wording differs.
- Use `docs/mode-prompt-audit-checklist.md` for broad prompt audits.

## Verification

- Re-read the final edited prompt variant and its corresponding `mode.md`.
- For runtime-sensitive changes, run the relevant integration coverage from root with `pnpm test:integration` or the focused mode integration test when available.

## Child DOX Index

| Path | Owner Doc | Scope |
|------|-----------|-------|
| `fuxi/` | this file | Fu Xi planning mode prompt variants. |
| `houtu/` | this file | Hou Tu execution mode prompt variants. |
| `kuafu/` | this file | Kua Fu build-orchestrator mode prompt variants. |
| `luban/` | this file | Lu Ban skill-first mode prompt variants. |
| `shennong/` | this file | Shen Nong product-manager mode prompt variants. |
