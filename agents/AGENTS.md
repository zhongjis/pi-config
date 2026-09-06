## Purpose

Callable Subagent definitions and their bounded delegation contracts.

## Ownership

- This document owns all agent definitions in this directory.
- Mode Agent prompts belong to [../modes/](../modes/).
- Runtime loading and enforcement belong to [../extensions/subagents/](../extensions/subagents/).

## Local Contracts

- You MUST follow the [frontmatter guide](../docs/guides/agent-frontmatter.md).
- You MUST preserve role boundaries in the [orchestration guide](../docs/guides/agent-orchestration.md).
- You MUST align tool allowlists with each agent's stated role.
- Read-only consultants MUST NOT receive mutating tools; bash requires runtime guarding.
- Mode frontmatter, not guide tables, authorizes mode-scoped delegation.

## Work Guidance

- You SHOULD keep routing descriptions specific to worker capability.
- You MUST preserve orchestrator-owned verification and code-quality review.

## Verification

- You MUST use the frontmatter guide's verification checklist after definition edits.
- Xuannv loading coverage: `pnpm exec vitest run --project unit test/planning-agent-contract.test.ts`.

## Child DOX Index

- None; this document owns all definitions and remaining files here.
