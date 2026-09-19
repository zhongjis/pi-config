---
name: panda-harness-tui-standard
description: Apply the Panda Harness standard to Pi TUI tool calls, results, notifications, collapsed and expanded rendering, width safety, and separation of human presentation from model-visible content. Use when designing, implementing, reviewing, or debugging these surfaces.
---

# Panda Harness TUI Standard

Use this skill for Panda Harness output shown through Pi tool renderers or custom-message notifications.

## Canonical guide

Before planning, editing, debugging, or reviewing, read [`docs/guides/tool-output-tui-rendering.md`](../../../docs/guides/tool-output-tui-rendering.md) completely. Treat it as the single source of truth for presentation contracts, implementation patterns, tests, real-TUI verification, and review criteria.

Keep rendering guidance in that guide. Update this skill only when its invocation or workflow changes.

## Workflow

1. Read the applicable `AGENTS.md` chain and the canonical guide.
2. Inspect the real tool or notification registration, result shape, renderer, tests, and representative output. Identify model-visible fields and delivery behavior before proposing presentation changes.
3. Follow the guide branch matching the request:
   - **Plan:** apply its implementation sequence to observed output shapes.
   - **Implement or debug:** apply its rendering contract and verification contract.
   - **Review:** apply its review checklist to the changed renderer and tests.
4. Update docs only at the owning level required by the repository contracts.

## Completion gate

Finish only when every applicable guide requirement is accounted for. For implementation work, require focused tests plus real Pi TUI evidence; confirm model-visible content, delivery, execution semantics, errors, and side effects remain unchanged unless the user explicitly requested otherwise.
