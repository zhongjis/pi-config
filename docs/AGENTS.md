## Purpose

Human-facing contracts, decisions, guides, ideas, and supporting evidence.

## Ownership

- [README.md](README.md) defines documentation buckets, lifecycle statuses, and authority.
- This document owns `adr/`, `agents/`, `diagrams/`, `guides/`, `ideas/`, `specs/`, and loose files.
- The references child owns archived evidence and external snapshots.
- [../GLOSSARY.md](../GLOSSARY.md) owns terminology, not system behavior.

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
- Diagram HTML is generated: edit the source `<name>.<type>.json`, pin `meta.repository.revision` to the commit its `sources` cite, and regenerate the HTML with the `archify` skill's `finalize`.

## Verification

- Diagrams: Archify `finalize <type> docs/diagrams/<name>/<name>.<type>.json docs/diagrams/<name>/<name>.html --repo-root . --quality showcase --out-dir <directory outside the repo>` passes every gate.

## Child DOX Index

- [references/AGENTS.md](references/AGENTS.md) — evidence, provenance, and generated snapshots.
