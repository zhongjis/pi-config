# Thinking Steps

Three-mode rendering of assistant thinking blocks in Pi's interactive TUI only: `collapsed`, `summary`, and `expanded`. It parses raw thinking text into semantic steps (plan / inspect / verify / decision / …) and replaces Pi's native raw-Markdown thinking view with a structured, summarized component. Mode is switchable live and can be persisted per project or globally. Messages without visible thinking show no thinking panel or extra spacing, during streaming or after completion. Real and provider-redacted thinking remain visible.

## Upstream

- Source: https://github.com/crustyhacker/pi-thinking-steps
- Version: v1.0.11 (commit `d0a59a4f394a8b13f58aa84c30e2dc4071b7c2fd`) plus v1.0.17 (commit `2209e03ad13e1eda2c66f5fd7a13932b584c4764`) shorter truncation notice: `Response was truncated before completion.`
- License: MIT
- Adapted: targets the `@earendil-works/pi-*` runtime; the renderer patch bare-imports `AssistantMessageComponent`, takes the theme from `ctx.ui.theme`, and preserves assistant Markdown transformers (including Mermaid) and streaming state without importing Pi internals. Empty thinking is silent rather than showing upstream placeholder panels. Upstream export, review, verbatim, search, compare, autosave, and diagnostics subcommands are not vendored.

## Entry Points

- `/thinking-steps [collapsed|summary|expanded]` — set the view for this session; prefix `project` or `global` to persist a default.
- `Alt+t` — cycle views.

[index.ts](index.ts) registers the command, shortcut, and hooks.

## Settings / Configuration

Persisted view-mode preference, resolved in order: session entry → project default → global default → `summary`. Project/global defaults are written via `/thinking-steps project|global …` ([persistence.ts](persistence.ts)).
