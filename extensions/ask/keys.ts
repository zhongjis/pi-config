/**
 * ask — Terminal key resolution and hint labels.
 *
 * Resolve select actions through Pi's injected keybindings; fixed tab, digit,
 * toggle and note keys remain available. No manager means terminal defaults.
 */

import { type KeyId, matchesKey } from "@earendil-works/pi-tui";
import type { KeyEvent } from "./state.js";

export type AskKeybinding = "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel" | "tui.input.submit";

/** Structural subset of Pi's KeybindingsManager. */
export interface AskKeybindings {
	matches(data: string, id: AskKeybinding): boolean;
	getKeys?(id: AskKeybinding): KeyId[];
}

const defaults: Record<AskKeybinding, KeyId[]> = {
	"tui.select.up": ["up"],
	"tui.select.down": ["down"],
	"tui.select.confirm": ["enter"],
	"tui.select.cancel": ["escape", "ctrl+c"],
	"tui.input.submit": ["enter"],
};

/** Hint label for one key id: arrows as glyphs, named keys and chords capitalized (`Esc`, `Ctrl+C`), plain letters as-is. */
export function keyLabel(key: string): string {
	const labels: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→", escape: "Esc" };
	const parts = key.split("+");
	return parts.map((part) => labels[part] ?? (parts.length > 1 || part.length > 1 ? part.charAt(0).toUpperCase() + part.slice(1) : part)).join("+");
}

export function createAskKeys(keybindings?: AskKeybindings): {
	resolve(data: string): KeyEvent | undefined;
	label(id: AskKeybinding): string;
} {
	const matches = (data: string, id: AskKeybinding): boolean => keybindings
		? keybindings.matches(data, id) : defaults[id].some((key) => matchesKey(data, key));
	return {
		resolve(data) {
			if (matches(data, "tui.select.up")) return { kind: "up" };
			if (matches(data, "tui.select.down")) return { kind: "down" };
			if (matches(data, "tui.select.confirm")) return { kind: "confirm" };
			if (matches(data, "tui.select.cancel")) return { kind: "cancel" };
			if (matchesKey(data, "tab") || matchesKey(data, "right")) return { kind: "nextTab" };
			if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) return { kind: "prevTab" };
			if (matchesKey(data, "space")) return { kind: "toggle" };
			if (/^[1-9]$/.test(data)) return { kind: "digit", n: Number(data) };
			if (data === "N" || matchesKey(data, "shift+n")) return { kind: "noteQuestion" };
			if (data === "n") return { kind: "noteOption" };
			return undefined;
		},
		label(id) {
			const first = (keybindings?.getKeys?.(id) ?? defaults[id])[0];
			return first === undefined ? "Unbound" : keyLabel(first);
		},
	};
}
