# smart-sessions

Maintains an LLM-generated one-line session summary as the session name, so active sessions and `/resume` entries show current work instead of only the first prompt.

## Upstream

- Source: https://github.com/pasky/pi-session-summary
- Version: 1.0.1
- Commit: 49902da5f42bd3c6d8954bbcf4d8bebeb220ed4b
- License: MIT
- Adapted: lives at `extensions/smart-sessions/`; notifications use the Pi-supported `info` level instead of upstream `success`.

## Terminal-host Titles

Inside herdr-app or Orca, the existing summary request also generates a separate meaningful title; the Pi session summary stays independent. Titles use `[w] ` followed by at most four words, counting whitespace and hyphens as separators.

Only Orca panes with no `paneTitle`, or whose current title starts with `[w]`, are eligible. Every other label is preserved, including other bracketed prefixes and ordinary custom names. Removing or replacing `[w]` opts out; clearing the label opts back in.

herdr-app titles name the **whole associated tab**, not an individual pane: the app exposes tab renaming, not pane renaming. Positional numeric default tab names, the agent name herdr-app's + menu gives an agent's tab (`Pi`), and own `[w]` names are eligible; manual names are preserved. HC labels are metadata, not visible titles.

When the session ends (quit, `/new`, `/resume`, `/fork`; not `/reload`), a title this process wrote is undone if the host still shows it: the herdr-app tab returns to the agent name it took over, else to its number. A label renamed in the meantime is left alone. Orca titles stay, and so does a title left by a hard kill until the next session reclaims it.

Updates follow the existing summary timing and debounce, not startup. [herdr.ts](herdr.ts) uses [shared host selection](../lib/pane-host.ts) and re-reads the live label/name before renaming; [index.ts](index.ts) owns the shared summary request. [App resolution](../lib/herdr-app.mjs) requires the exact current HC terminal’s tab/pane association; missing or malformed layouts never fall back to another host or focus. Outside supported hosts, summaries follow the plain one-line path.

## Entry Points

- `/summary:update` forces an update; `/summary:settings`, `/summary:clear`, and `/summary:cost` manage settings, the name, and usage. [index.ts](index.ts) registers them.
- Summaries and the `/summary:*` commands run only in terminal sessions; RPC clients such as T3 Code own their thread titles.

## Settings / Configuration

Global config: `~/.pi/agent/session-summary.json`.
Project override: `.pi/session-summary.json`.

When `provider` or `model` is blank, the `smart-sessions.summary` role from `tool_models.json` selects the model. [index.ts](index.ts) defines the remaining keys and defaults.
