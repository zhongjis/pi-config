# docs

## Purpose

Human-facing design docs, standards, and reference material for Panda Harness.

## Ownership

This file owns `docs/` except child docs listed below. Root `AGENTS.md` still owns repo-wide policy.

## Local Contracts

- Keep docs factual and current with code and repo workflows.
- Put extension README rules in `docs/specs/extensions.md` and testing rules in `docs/guides/testing/`.
- Event semantics must agree with `extensions/CONVENTIONS.md`.
- Do not turn docs into changelogs; record durable current behavior.
- Every document under `ideas/` is non-binding and carries `Status: idea`.
- Treat `adr/` as append-only ADRs: one decision per document, including why the chosen option won.
- Keep `references/` for stable, citable external material only.
- Oh My OpenAgent reference archive lives in `references/oh-my-openagent/final-prompts/`; refresh with `pnpm sync:oh-my-openagent-prompts`, verify with `pnpm check:oh-my-openagent-prompts`, and never hand-edit generated prompt files. The Pi-adapted active `ulw-plan` is mode-owned at `modes/fuxi/skills/ulw-plan/`.

## Work Guidance

- Update docs near the contract they describe.
- For extension testing changes, update `docs/guides/testing/README.md` or its child docs instead of root README.
- For model role/fallback behavior, keep `docs/specs/extension-model-usage.md` and `docs/specs/model-selection-and-fallback.md` aligned.

## Verification

- For doc-only edits, verify referenced paths exist.
- For docs describing commands, confirm the command exists in `package.json`, `install.sh`, or the referenced script.

## Child DOX Index

| Path | Owner Doc | Scope |
|------|-----------|-------|
| `ideas/` | this file | Speculative, non-binding notes marked `Status: idea`. |
| `specs/` | this file | Panda Harness contracts. |
| `adr/` | this file | Append-only, single-decision ADRs. |
| `guides/` | this file | Task-oriented instructions (e.g. testing). |
| `references/` | this file | Stable, citable external material. |
