# modes

Per-model-family prompt variants for the four primary mode agents.

Each mode directory contains:
- `mode.md` — default prompt body (Claude/default family), frontmatter + full body
- `gpt.md` — GPT-family variant body (principle-driven, body only, no frontmatter)
- `gemini.md` — Gemini-family corrective overlay fragments (body only, no frontmatter)

kuafu and fuxi have gpt.md and gemini.md variants; houtu and luban use mode.md only (v1).

Install: `bash install.sh` symlinks this directory to `~/.pi/agent/modes/`.
