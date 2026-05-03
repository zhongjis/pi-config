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
3. Extension statuses on the left and infrastructure statuses such as MCP/LSP on the right.

It hides low-value status keys (`thinking-steps`, `caveman`), strips decorative leading glyphs from selected status text, color-codes context/cost thresholds, and prints a `pi --session <id>` continuation hint on user-initiated exits.

## Write Tool Override

Overrides the built-in `write` tool rendering only; file creation/overwrite behavior remains delegated to Pi's built-in write tool.

- Call rendering shows `write <path> (<line count> lines)`.
- Partial result rendering shows `Writing...`.
- Success rendering shows `✓ Written`.
- Error rendering shows the first error line.

## Hooks and Tools

Hooks:

- `session_start` — install the footer.
- `model_select` — reinstall the footer so model/thinking display stays current.
- `session_shutdown` — print the continuation hint for user exits.

Tools:

- `write` — built-in write tool with custom visual renderers.
