# visuals

Composite visual identity extension for this Pi harness. It combines the compact footer and `write` tool rendering override that previously lived as separate visual-only extensions.

## Visual Identity

- Keeps the Pi interface compact and session-focused.
- Uses muted/accent/success/error theme colors instead of verbose output blocks.
- Prioritizes high-signal session metadata: location, branch, model, context, tokens, speed, cost, and active extension statuses.

## Footer

Replaces the default footer with up to four compact lines:

1. Project directory (basename when on a git branch, otherwise shortened path) · git branch · session name.
2. Context usage/window · model/thinking level · latest tok/s · cost/subscription state · token I/O/cache totals.
3. Extension statuses on the left and infrastructure statuses such as MCP/LSP on the right.
4. Goal indicator (only when a goal is set), colored by goal status.

It hides low-value status keys (`thinking-steps`, `caveman`), strips decorative leading glyphs from selected status text, and color-codes context/cost thresholds.

### Goal integration

Only one extension can own the single `ctx.ui.setFooter()` slot. This extension claims that slot and advertises ownership on the `Symbol.for("pi-visuals:footer")` global. The [`goal`](../goal/) extension sees that flag and, instead of installing its own competing footer, publishes its current indicator on the `Symbol.for("pi-goal:footer")` global (a `{ getIndicator(): { text, color } | null }` bridge). The footer reads that bridge each render and appends the goal line. This mirrors the `Symbol.for("pi-subagents:manager")` bridge already read for subagent cost. When `visuals` is absent, `goal` falls back to installing its own footer.

## Write Tool Override

Overrides the built-in `write` tool rendering only; file creation/overwrite behavior remains delegated to Pi's built-in write tool.

- Call rendering shows `▸ write · <path>` with long paths safely truncated.
- Collapsed results show `status: written`, `size: N lines`, `error: <first line>`, or `status: writing`, plus the expand hint.
- Expanded results show the raw built-in `write` result content exactly.

## Hooks and Tools

Hooks:

- `session_start` — install the footer.
- `model_select` — reinstall the footer so model/thinking display stays current.

Tools:

- `write` — built-in write tool with custom visual renderers.
