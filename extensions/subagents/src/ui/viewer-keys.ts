/**
 * viewer-keys.ts — Scroll key matchers for the conversation viewer.
 *
 * Resolves `tui.select.*` through the user's keybindings when pi provides a
 * manager, falling back to the previous hardcoded keys otherwise. The viewer's
 * k/j and shift+arrow aliases always work alongside whatever is bound.
 */

import { type KeyId, matchesKey } from "@earendil-works/pi-tui";

/** The `tui.select.*` keybinding ids the viewer resolves. */
export type ViewerScrollKeybinding =
  | "tui.select.up"
  | "tui.select.down"
  | "tui.select.pageUp"
  | "tui.select.pageDown";

/** Structural subset of pi-tui's `KeybindingsManager` (which satisfies it). */
export interface ViewerKeybindings {
  matches(data: string, keybinding: ViewerScrollKeybinding): boolean;
  getKeys?(keybinding: ViewerScrollKeybinding): KeyId[];
}

export interface ViewerKeys {
  scrollUp(data: string): boolean;
  scrollDown(data: string): boolean;
  pageUp(data: string): boolean;
  pageDown(data: string): boolean;
  navigationHint(): string;
}

export function createViewerKeys(keybindings?: ViewerKeybindings): ViewerKeys {
  const matches = (data: string, id: ViewerScrollKeybinding, fallback: KeyId): boolean =>
    keybindings ? keybindings.matches(data, id) : matchesKey(data, fallback);
  const label = (id: ViewerScrollKeybinding, fallback: string): string => {
    const keys = keybindings?.getKeys?.(id);
    return keys ? keys.join("/") || "Unbound" : fallback;
  };
  return {
    scrollUp: (data) => matches(data, "tui.select.up", "up") || matchesKey(data, "k"),
    scrollDown: (data) => matches(data, "tui.select.down", "down") || matchesKey(data, "j"),
    pageUp: (data) => matches(data, "tui.select.pageUp", "pageUp") || matchesKey(data, "shift+up"),
    pageDown: (data) => matches(data, "tui.select.pageDown", "pageDown") || matchesKey(data, "shift+down"),
    navigationHint: () => keybindings?.getKeys
      ? `${label("tui.select.up", "↑")}/${label("tui.select.down", "↓")} scroll · ${label("tui.select.pageUp", "PgUp")}/${label("tui.select.pageDown", "PgDn")} page`
      : "↑↓ scroll · PgUp/PgDn or Shift+↑↓",
  };
}
