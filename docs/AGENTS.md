## Purpose

Human-facing contracts, decisions, guides, ideas, and supporting evidence.

## Ownership

- [README.md](README.md) defines documentation buckets, lifecycle statuses, and authority.
- This document owns `adr/`, `agents/`, `guides/`, `ideas/`, `specs/`, and loose files.
- The references child owns archived evidence and external snapshots.
- [../CONTEXT.md](../CONTEXT.md) owns terminology, not system behavior.

## Local Contracts

- You MUST use README bucket/status and authority rules when authoring docs.
- Ideas MUST carry exact `Status: idea`; they are non-binding.
- You MUST supersede ADRs with new decisions and reciprocal links.
- References are evidence, never execution policy.
- You MUST distinguish shipped contracts from draft, planned, or retired material.

## Work Guidance

- You SHOULD link authoritative contracts rather than duplicate them.
- You MUST verify inventories against current owners before repeating them.
- Mode construction belongs to [../modes/README.md](../modes/README.md), not historical inventory tables.
- Workflow presentation scope lives in [its spec](specs/workflow-tool-output-presentation.md); [the implementation plan](guides/workflow-presentation-implementation.md) records execution and verification, never weaker acceptance.
- [guides/orchistration.md](guides/orchistration.md) owns lifecycle and how-to guidance; [guides/agent-orchestration.md](guides/agent-orchestration.md) owns the role and delegation map.

## Verification

## Child DOX Index

- [references/AGENTS.md](references/AGENTS.md) — evidence, provenance, and generated snapshots.
