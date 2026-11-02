## Purpose

Provide structured user decisions in the interactive TUI; other modes, including RPC, get a question list.

## Ownership

- Owns the `ask` tool, dialog state, rendering, the disabled RPC dialog driver, and tests.

## Local Contracts

- [The dialog](dialog.ts) MUST always show question and Review tabs, including single-question dialogs.
- Non-TUI modes, including RPC, MUST return the [question list](format.ts) without opening dialogs while `RPC_DIALOGS` in [index.ts](index.ts) is off.
- [The RPC driver](rpc.ts) MUST use only blocking dialog methods (`select`, `input`, `editor`) from Pi's RPC extension UI protocol and MUST return the same `AskDetails` shape as the TUI dialog.

## Work Guidance

## Verification

- `pnpm exec vitest run --project unit extensions/ask/test`

## Child DOX Index

- None.
