## Purpose

Provide structured user decisions in the interactive TUI and in RPC clients.

## Ownership

- Owns the `ask` tool, dialog state, rendering, the RPC dialog driver, and tests.

## Local Contracts

- [The dialog](dialog.ts) MUST always show question and Review tabs, including single-question dialogs.
- [The RPC driver](rpc.ts) MUST use only blocking dialog methods (`select`, `input`, `editor`) from Pi's RPC extension UI protocol and MUST return the same `AskDetails` shape as the TUI dialog.

## Work Guidance

## Verification

- `pnpm exec vitest run --project unit extensions/ask/test`

## Child DOX Index

- None.
