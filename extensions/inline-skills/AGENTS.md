## Purpose

Provide vendored `$skill:` and `$graph:` prompt tokens for inline skill loading and explicit saved-graph selection.

## Ownership

- Owns token autocomplete, skill injection, session-bound graph authorization, tests, and vendoring records.
- [index.ts](index.ts) owns the hook inventory; [README](README.md) owns upstream provenance.
- Saved-graph resolution belongs to [subagents](../subagents/AGENTS.md).

## Local Contracts

- `inline-skills` MUST preserve visible `$skill:<name>` tokens and explicit `$graph:<name>` tokens. Graph authorization is session-bound, carries the selected saved graph's compiled input-schema validator, permits one tokenless clarification turn, consumes only a matching call with valid coerced input, guards follow-up tool calls after consumption until the next ordinary user input, never executes directly, and reuses subagents saved-graph resolution for autocomplete and errors.

## Work Guidance

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/inline-skills`.

## Child DOX Index

- None; this document owns the entire subtree.
