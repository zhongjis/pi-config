# pi-tool-output-presentation

## Purpose

Repo-local skill for Pi tool TUI output presentation: `renderCall` / `renderResult`, collapsed summaries, expanded raw output, and tests that preserve model-visible `content`.

## Local Contracts

- Keep `SKILL.md` a thin operational entrypoint to the canonical `docs/guides/tool-output-tui-rendering.md`; keep rendering guidance in that guide.
- Keep eval prompts under `evals/evals.json`; they test planning, implementation, and review use cases.
- Do not add scripts unless repeated eval/verification work justifies them.

## Verification

- Re-read `SKILL.md` after edits.
- Validate `evals/evals.json` as JSON.
- If eval viewer artifacts are regenerated, keep them in the sibling workspace, not inside the skill directory.

## Child DOX Index

No child `AGENTS.md` files. This file owns all files under this skill directory.
