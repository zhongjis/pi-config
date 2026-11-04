## Purpose

Maintain LLM-generated session names, Orca pane titles, and herdr-app tab names.

## Ownership

- Owns session summaries, terminal-host title integration, and tests.

## Local Contracts

- [smart-sessions](herdr.ts) MUST generate host titles separately within the existing summary call, preserve Pi summaries, and rename only the current Orca terminal when its label is unset or carries its own `[w]` marker, after reading the current label. Orca ownership reads only `paneTitle`, never the auto-derived `title`. Removing the ownership marker opts out; no startup renames, additional model calls, or title persistence. For herdr-app, rename only the exact HC terminal’s associated tab after re-reading its name; positional numeric defaults, a name equal to the terminal’s reported agent (`app`, case-insensitive; herdr-app’s + menu names agent tabs this way), and own `[w]` names are eligible, manual names are preserved. The app title is tab-scoped, not pane-scoped.
- On `session_shutdown` for any reason except `reload`, restore only a title this process wrote and the host still shows: reset the herdr-app tab to the agent name it took over, else to its number with an empty name. Orca titles are not restored.

## Work Guidance

## Verification

- `pnpm exec vitest run --project unit extensions/smart-sessions/test`

## Child DOX Index

- None.
