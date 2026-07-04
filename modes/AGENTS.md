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
- Prompt audits must inspect the final injected prompt, not only source fragments.
- When mode prompts mention code intelligence, preserve the split: CodeGraph for broad structure/impact, LSP for symbol-precise facts and diagnostics, `rg`/`fd` for literal/file search.
- For orchestration modes, keep delegation chunks worker-sized: one domain, one deliverable, usually ≤3 expected product files; split state/API/UI/tests/docs/git unless tightly coupled. A task kept whole under that coupling exception must still be recoverable: staging, a green checkpoint, a tool-call ceiling, and a fail-safe (stop at last green state, report a resume anchor, never leave the tree broken).
- Frontend/web UI implementation, styling, layout, components, visual behavior, and browser QA route to `yunu`; keep `jintong` as the non-UI implementation/debug/test worker.

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
