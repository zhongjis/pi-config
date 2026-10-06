## Purpose

Human-facing contracts, decisions, guides, ideas, and supporting evidence.

## Ownership

- [README.md](README.md) defines documentation buckets, lifecycle statuses, and authority.
- This document owns `adr/`, `agents/`, `guides/`, `ideas/`, `specs/`, and loose files.
- The references child owns archived evidence and external snapshots.
- [../CONTEXT.md](../CONTEXT.md) owns terminology, not system behavior.

## Local Contracts

- When authoring docs, you MUST follow [root documentation rules](../AGENTS.md#documentation-rules) and [README buckets](README.md#documentation-buckets).
- When assigning spec or idea status or superseding ADRs, you MUST follow [README lifecycle rules](README.md#lifecycle-statuses).
- When resolving behavioral conflicts or using references, you MUST follow [README authority order](README.md#authority-order).

## Work Guidance

- You SHOULD link authoritative contracts rather than duplicate them.
- Mode construction belongs to [../modes/README.md](../modes/README.md).
- [Herdr agent-graph presentation](specs/herdr-agent-graph-presentation.md) owns graph panel presentation in Pi and the Herdr pane; it does not redesign transcript tool rows or notifications.
- [Subagent tool output presentation](specs/subagent-tool-output-presentation.md) covers Subagent tool rows; [Tool Output TUI Rendering Guide](guides/tool-output-tui-rendering.md) owns cross-Extension tool-call, tool-result, notification, and interactive-view rules.
- [guides/orchistration.md](guides/orchistration.md) owns lifecycle and how-to guidance; [guides/agent-orchestration.md](guides/agent-orchestration.md) owns the role and delegation map.

## Verification

## Child DOX Index

- [references/AGENTS.md](references/AGENTS.md) — evidence, provenance, and generated snapshots.
