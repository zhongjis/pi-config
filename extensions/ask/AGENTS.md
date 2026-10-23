## Purpose

Provide structured user decisions in the interactive TUI.

## Ownership

- Owns the `ask` tool, dialog state, rendering, and tests.

## Local Contracts

- [The dialog](dialog.ts) MUST always show question and Review tabs, including single-question dialogs.

## Work Guidance

## Verification

- `pnpm exec vitest run --project unit extensions/ask/test`

## Child DOX Index

- None.
