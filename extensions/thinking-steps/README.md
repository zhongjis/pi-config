# Thinking Steps

Three-mode rendering of assistant thinking blocks in Pi's interactive TUI only: `collapsed`, `summary`, and `expanded`. It parses raw thinking text into semantic steps (plan / inspect / verify / decision / …) and replaces Pi's native raw-Markdown thinking view with a structured, summarized component. Mode is switchable live and can be persisted per project or globally.

## Upstream

- Source: https://github.com/fluxgear/pi-thinking-steps
- Version: v1.0.11 (commit `d0a59a4f394a8b13f58aa84c30e2dc4071b7c2fd`)
- License: MIT
- Adapted: targets the `@earendil-works/pi-*` runtime; the renderer patch bare-imports `AssistantMessageComponent`, takes the theme from `ctx.ui.theme`, and preserves assistant Markdown transformers (including Mermaid) and streaming state.

## Entry Points

- `/thinking-steps [collapsed|summary|expanded]` — set the view for this session; prefix `project` or `global` to persist a default.
- `Alt+t` — cycle views.

[index.ts](index.ts) registers the command, shortcut, and hooks.

## Settings / Configuration

Persisted view-mode preference, resolved in order: session entry → project default → global default → `summary`. Project/global defaults are written via `/thinking-steps project|global …` ([persistence.ts](persistence.ts)).
