# modes

Per-model-family prompt variants for the four primary mode agents.

Prompt construction:
- Default family uses `mode.md` frontmatter + body.
- GPT family uses `gpt.md` as a body-only replacement; it retains `mode.md` frontmatter and must be self-contained.
- Gemini family uses `gemini.md` as a body-only corrective overlay on the default `mode.md` body.

Current file matrix:

| Mode | `mode.md` | `gpt.md` | `gemini.md` |
|---|---:|---:|---:|
| kuafu | Yes | Yes | Yes |
| fuxi | Yes | Yes | Yes |
| houtu | Yes | Yes | Yes |
| luban | Yes | Yes | Yes |

Prompt audits must review the final injected prompt, not only source files. See `../docs/mode-prompt-audit-checklist.md`.

Install: `bash install.sh` symlinks this directory to `~/.pi/agent/modes/`.
