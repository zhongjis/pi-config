# visuals

Composite visual identity extension for this Pi harness. It combines the compact footer and `write` tool rendering override that previously lived as separate visual-only extensions.

## Visual Identity

- Keeps the Pi interface compact and session-focused.
- Uses muted/accent/success/error theme colors instead of verbose output blocks.
- Prioritizes high-signal session metadata: location, branch, model, context, tokens, speed, cost, and active extension statuses.

## Footer

Replaces the default footer with up to three compact lines:

1. Project directory (basename when on a git branch, otherwise shortened path) · git branch · session name.
2. Context usage/window · model/thinking level · latest tok/s · cost/subscription state · token I/O/cache totals.
3. Extension statuses on the left; on the right, the goal indicator (when a goal is set) followed by infrastructure statuses (MCP, LSP). The goal indicator sits to the left of LSP.

It hides low-value status keys (`thinking-steps`, `caveman`), strips decorative leading glyphs from selected status text, and color-codes context/cost thresholds.

### LSP indicator

The LSP status comes from the [`lsp`](../lsp/) extension, which emits `LSP N/M running` only when `N` servers are active (otherwise `LSP 0/M`, `LSP none`, or `LSP disabled`). The footer shows LSP **only when at least one server is active**, drops the `running` phrase, and colorizes the label (active state is conveyed by color, not text). Other infra (MCP, …) keeps its muted `KEY detail` form.

### Goal integration

Only one extension can own the single `ctx.ui.setFooter()` slot. This extension claims that slot and advertises ownership on the `Symbol.for("pi-visuals:footer")` global. The [`goal`](../goal/) extension sees that flag and, instead of installing its own competing footer, publishes its current indicator on the `Symbol.for("pi-goal:footer")` global (a `{ getIndicator(): { text, color } | null }` bridge). The footer reads that bridge each render and places the goal indicator on line 3, to the left of the LSP/infra group, colored by goal status. This mirrors the `Symbol.for("pi-subagents:manager")` bridge already read for subagent cost. When `visuals` is absent, `goal` falls back to installing its own footer.

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
