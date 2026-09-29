## Purpose

Human-facing contracts, decisions, guides, ideas, and supporting evidence.

## Ownership

- [README.md](README.md) defines documentation buckets, lifecycle statuses, and authority.
- This document owns `adr/`, `agents/`, `guides/`, `ideas/`, `specs/`, and loose files.
- The references child owns archived evidence and external snapshots.
- [../CONTEXT.md](../CONTEXT.md) owns terminology, not system behavior.

## Local Contracts

- You MUST use README bucket, status, writing, and authority rules when authoring docs.
- Docs MUST describe current state only. Dates, commit narratives, migration notes, and implementation records are forbidden outside ADRs and `CHANGELOG.md` files.
- Code is the source of truth. Docs MUST link to the owning code instead of copying volatile inventories.
- You MUST delete specs, guides, and ideas that no longer describe current or proposed behavior; never keep retired records.
- Ideas MUST carry exact `Status: idea`; they are non-binding.
- You MUST supersede ADRs with new decisions and reciprocal links.
- References are evidence, never execution policy.

## Work Guidance

- You SHOULD link authoritative contracts rather than duplicate them.
- Mode construction belongs to [../modes/README.md](../modes/README.md).
- [Herdr agent-graph presentation](specs/herdr-agent-graph-presentation.md) owns graph panel presentation in Pi and the Herdr pane; it does not redesign transcript tool rows or notifications.
- [Subagent tool output presentation](specs/subagent-tool-output-presentation.md) covers Subagent tool rows; [Tool Output TUI Rendering Guide](guides/tool-output-tui-rendering.md) owns cross-Extension tool-call, tool-result, notification, and interactive-view rules.
- [guides/orchistration.md](guides/orchistration.md) owns lifecycle and how-to guidance; [guides/agent-orchestration.md](guides/agent-orchestration.md) owns the role and delegation map.

## Verification

## Child DOX Index

- [references/AGENTS.md](references/AGENTS.md) — evidence, provenance, and generated snapshots.
