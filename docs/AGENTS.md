# docs

## Purpose

Human-facing design docs, standards, and reference material for Panda Harness.

## Ownership

This file owns `docs/` except child docs listed below. Root `AGENTS.md` still owns repo-wide policy.

## Local Contracts

- Keep docs factual and current with code and repo workflows.
- Put extension README rules in `docs/extensions.md` and testing rules in `docs/testing/`.
- Event semantics must agree with `extensions/CONVENTIONS.md`.
- Do not turn docs into changelogs; record durable current behavior.

## Work Guidance

- Update docs near the contract they describe.
- For extension testing changes, update `docs/testing/README.md` or its child docs instead of root README.
- For model role/fallback behavior, keep `docs/extension-model-usage.md` and `docs/model-selection-and-fallback.md` aligned.

## Verification

- For doc-only edits, verify referenced paths exist.
- For docs describing commands, confirm the command exists in `package.json`, `install.sh`, or the referenced script.

## Child DOX Index

| Path | Owner Doc | Scope |
|------|-----------|-------|
| `testing/` | this file + `testing/README.md` | Test tiers, unit/integration conventions, and pi-test-harness notes. |
