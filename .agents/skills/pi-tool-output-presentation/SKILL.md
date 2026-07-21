---
name: pi-tool-output-presentation
description: Polish Pi tool TUI output. Use when designing, implementing, reviewing, or debugging `renderCall`/`renderResult`, collapsed or expanded results, progress and error states, width safety, or separation of human presentation from model-visible content.
---

# Pi Tool Output Presentation

Use this skill for Pi custom-tool or extension output shown through `renderCall` and `renderResult`.

## Canonical guide

Before planning, editing, debugging, or reviewing, read [`docs/guides/tool-output-tui-rendering.md`](../../../docs/guides/tool-output-tui-rendering.md) completely. Treat it as the single source of truth for presentation contracts, implementation patterns, tests, real-TUI verification, and review criteria.

Keep rendering guidance in that guide. Update this skill only when its invocation or workflow changes.

## Workflow

1. Read the applicable `AGENTS.md` chain and the canonical guide.
2. Inspect the real tool registration, execution result shape, renderer, tests, and representative outputs. Identify model-facing fields before proposing presentation changes.
3. Follow the guide branch matching the request:
   - **Plan:** apply its implementation sequence to observed output shapes.
   - **Implement or debug:** apply its rendering contract and verification contract.
   - **Review:** apply its review checklist to the changed renderer and tests.
4. Update docs only at the owning level required by the repository contracts.

## Completion gate

Finish only when every applicable guide requirement is accounted for. For implementation work, require focused tests plus real Pi TUI evidence; confirm model-facing content, execution semantics, errors, and side effects remain unchanged unless the user explicitly requested otherwise.
