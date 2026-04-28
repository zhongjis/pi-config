# init-deep

Generates hierarchical AGENTS.md files for the current project via an orchestrated multi-phase workflow.

## What It Does

- Injects a detailed instruction prompt that guides the agent through a 4-phase workflow:
  1. **Discovery** — Background codebase exploration agents + bash analysis + LSP codemap + read existing AGENTS.md files
  2. **Scoring** — Score directories by complexity (file count, subdir count, code ratio, symbol density, etc.) to decide which need AGENTS.md
  3. **Generation** — Root AGENTS.md first, then subdirectory AGENTS.md files in parallel via jintong agents
  4. **Review** — Deduplicate, trim, validate against size limits (root: 50-150 lines, subdirs: 30-80 lines)
- Dynamically scales agent count based on project size (files, lines, depth, languages)
- Supports update mode (modify existing + create new) and `--create-new` (regenerate from scratch)
- Depth-limited with `--max-depth=N` (default: 3)

## Commands

- `/init-deep` — Update mode: modify existing + create new AGENTS.md files where warranted
- `/init-deep --create-new` — Read existing → remove all → regenerate from scratch
- `/init-deep --max-depth=N` — Limit directory traversal depth
