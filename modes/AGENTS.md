# modes

## Purpose

Mode prompt definitions and model-family prompt variants for Kua Fu, Fu Xi, Hou Tu, and Lu Ban.

## Ownership

This file owns `modes/` prompt files and mode subdirectories.

## Local Contracts

- `mode.md` carries canonical frontmatter plus default prompt body.
- `gpt.md` is a body-only replacement; it inherits `mode.md` frontmatter and must be self-contained.
- `gemini.md` is a body-only corrective overlay on the default prompt body.
- Keep the four-mode file matrix complete unless intentionally removing a mode family.
- Prompt audits must inspect the final injected prompt, not only source fragments.
- When mode prompts mention code intelligence, preserve the split: CodeGraph for broad structure/impact, LSP for symbol-precise facts and diagnostics, `rg`/`fd` for literal/file search.

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
