# modes

Per-model-family prompt variants for mode agents.

Prompt construction:
- Default family uses `mode.md` frontmatter + body.
- GPT family uses `gpt.md` as a body-only replacement; it retains `mode.md` frontmatter and must be self-contained.
- Gemini family uses `gemini.md` as a body-only corrective overlay on the default `mode.md` body.
- Mode-scoped skills live under `modes/<mode>/skills/*/SKILL.md`. Runtime may preload/inject active skills.

Fu Xi architecture:
- Fu Xi prompt files are a thin Prometheus family.
- Active planner policy is injected from `modes/fuxi/skills/ulw-plan/SKILL.md`; its `references/*` files are loaded relative to the skill base dir.
- Fu Xi’s exactly seven planning stages are authoritative in `modes/fuxi/skills/ulw-plan/SKILL.md`; do not duplicate them here.

Current file matrix:

| Mode | `mode.md` | `gpt.md` | `gemini.md` | mode skill migration |
|---|---:|---:|---:|---|
| kuafu | Yes | Yes | Yes | none |
| fuxi | Yes | Yes | Yes | active `skills/ulw-plan` |
| houtu | Yes | Yes | Yes | none |
| luban | Yes | Yes | Yes | active 14-skill Superpowers snapshot; Luban-only discovery |
| shennong | Yes | Yes | Yes | future / out of scope |

Prompt audits must review the final injected prompt, not only source files, and preserve locked family anchors plus the final injected session audit requirement. See `../docs/specs/mode-prompt-audit-checklist.md`.

Install: `bash install.sh` symlinks this directory to `~/.pi/agent/modes/`.
