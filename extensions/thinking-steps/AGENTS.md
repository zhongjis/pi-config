## Purpose

Render assistant thinking blocks as structured steps in the interactive TUI.

## Ownership

- Owns thinking parsing, rendering, internal patching, persistence, and tests.

## Local Contracts

- MUST preserve native assistant Markdown transformers (including Mermaid) and streaming state while retaining its custom thinking display. Messages without visible thinking MUST remain silent, without placeholder panels or extra spacing; real and redacted thinking remain visible.

## Work Guidance

## Verification

- `pnpm exec vitest run --project unit extensions/thinking-steps/test`

## Child DOX Index

- None.
