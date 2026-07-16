# Thinking Steps

Three-mode rendering of assistant thinking blocks in Pi's interactive TUI only: `collapsed`, `summary`, and `expanded`. It parses raw thinking text into semantic steps (plan / inspect / verify / decision / …) and replaces Pi's native raw-Markdown thinking view with a structured, summarized component. Mode is switchable live and can be persisted per project or globally.
## Upstream

- Source: https://github.com/fluxgear/pi-thinking-steps
- Last synced: v1.0.11 (commit `d0a59a4f394a8b13f58aa84c30e2dc4071b7c2fd`, MIT)
- Local changes: adapted from the `@mariozechner/pi-*` (0.69.0-era) API to the `@earendil-works/pi-*` 0.80.x runtime. The internal-renderer patch no longer resolves Pi internals by filesystem path (dead on the Bun binary); it bare-imports the runtime-aliased `AssistantMessageComponent` and sources the theme from `ctx.ui.theme`. See `AGENTS.md` → `## Local Tweaks`.

## Commands

- `/thinking-steps [collapsed|summary|expanded]` — set the view for this session.
- `/thinking-steps [project|global] [collapsed|summary|expanded|clear]` — set or clear a persisted default.

## Shortcuts

- `Alt+t` — cycle view (collapsed → summary → expanded).

## Hooks

- `session_start` — installs the `AssistantMessageComponent` prototype patch and restores the saved view mode (interactive TUI sessions only).
- `message_start` / `message_update` / `message_end` / `agent_end` — track active thinking state for the live "Thinking…" indicator.
- `session_shutdown` — releases the patch and clears per-scope state.

## Settings / Configuration

Persisted view-mode preference, resolved in order: session entry → project default → global default → `summary`. Project/global defaults are written via `/thinking-steps project|global …` (persistence handled in `persistence.ts`).

## Local Additions

None beyond the upstream feature set — this is a compatibility adaptation, not a feature fork.
