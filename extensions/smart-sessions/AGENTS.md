## Purpose

Maintain LLM-generated session names and Herdr pane titles.

## Ownership

- Owns session summaries, Herdr title integration, and tests.

## Local Contracts

- [smart-sessions](herdr.ts) MUST generate Herdr titles separately within the existing summary call, preserve Pi summaries, and rename only the current pane when its label is unset or carries its own `[w]` marker, after reading the current label. Removing the ownership marker opts out; no startup renames, additional model calls, or title persistence.

## Work Guidance

## Verification

- `pnpm exec vitest run --project unit extensions/smart-sessions/test`

## Child DOX Index

- None.
