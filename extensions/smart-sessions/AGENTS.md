## Purpose

Maintain LLM-generated session names and herdr-app tab names.

## Ownership

- Owns session summaries, terminal-host title integration, and tests.

## Local Contracts

- [smart-sessions](herdr.ts) MUST generate host titles separately within the existing summary call and preserve Pi summaries, without startup renames, additional model calls, or title persistence. Rename only the exact HC terminal’s associated tab after re-reading its name; positional numeric defaults, a name equal to the terminal’s reported agent (`app`, case-insensitive; herdr-app’s + menu names agent tabs this way), and own `[w]` names are eligible, manual names are preserved. The app title is tab-scoped, not pane-scoped.
- On `session_shutdown` for any reason except `reload`, restore only a title this process wrote and the host still shows: reset the herdr-app tab to the agent name it took over, else to its number with an empty name.

## Work Guidance

## Verification

- `pnpm exec vitest run --project unit extensions/smart-sessions/test`

## Child DOX Index

- None.
