## Purpose

Maintain LLM-generated session names and per-pane `pi.session` labels.

## Ownership

- Owns session summaries, terminal-host title integration, and tests.

## Local Contracts

- [smart-sessions](herdr.ts) MUST generate host titles separately within the existing summary call and preserve Pi summaries, without startup renames, additional model calls, or title persistence. Write the title only as the exact HC terminal’s `pi.session=[w] <title>` label; never rename herdr-app tabs, which panes share.
- On `session_shutdown` for any reason except `reload`, clear the label this process wrote.

## Work Guidance

## Verification

- `pnpm exec vitest run --project unit extensions/smart-sessions/test`

## Child DOX Index

- None.
