import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
export function isTui(ctx: Pick<ExtensionContext, "mode">): boolean {
  return ctx.mode === "tui";
}
