import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

// ---------------------------------------------------------------------------
// registerTuiCommand / registerTuiShortcut
// ---------------------------------------------------------------------------

/**
 * Register a terminal-only command so it exists only in TUI sessions.
 *
 * The extension factory has no run mode and Pi has no `unregisterCommand`, so a
 * factory-time registration also lists the command in RPC `get_commands` (for
 * example T3 Code). Registering from `session_start` keeps it out of RPC, JSON,
 * and print runs. Relies on Pi awaiting `session_start` before it builds slash
 * autocomplete (verified on Pi 1.4.0 for startup, session replacement, and
 * `/reload`). A repeated `session_start` overwrites the command by name.
 */
export function registerTuiCommand(
  pi: ExtensionAPI,
  name: string,
  options: Parameters<ExtensionAPI["registerCommand"]>[1],
): void {
  pi.on("session_start", (_event, ctx) => {
    if (isTui(ctx)) pi.registerCommand(name, options);
  });
}

/**
 * Register a terminal-only shortcut so it exists only in TUI sessions.
 * Same contract as {@link registerTuiCommand}; Pi binds extension shortcuts
 * after `session_start`.
 */
export function registerTuiShortcut(
  pi: ExtensionAPI,
  shortcut: Parameters<ExtensionAPI["registerShortcut"]>[0],
  options: Parameters<ExtensionAPI["registerShortcut"]>[1],
): void {
  pi.on("session_start", (_event, ctx) => {
    if (isTui(ctx)) pi.registerShortcut(shortcut, options);
  });
}
