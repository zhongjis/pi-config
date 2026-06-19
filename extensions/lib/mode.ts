type ModeContext = { mode?: unknown };

// ---------------------------------------------------------------------------
// isTui
// ---------------------------------------------------------------------------

/**
 * True only when terminal-only TUI features work: `ui.custom()`, component
 * factories (`ui.setEditorComponent()`), and direct terminal rendering.
 *
 * Gate those features on `ctx.mode === "tui"`, NOT `ctx.hasUI`. `hasUI` is
 * `true` in BOTH TUI and RPC modes, but `ui.custom()` returns `undefined` and
 * component factories do not render under RPC — so `hasUI` cannot gate them.
 */
export function isTui(ctx: unknown): boolean {
  return typeof ctx === "object" && ctx !== null && "mode" in ctx && (ctx as ModeContext).mode === "tui";
}
