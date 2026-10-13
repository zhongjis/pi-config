import { describe, expect, it } from "vitest";
import { createAskKeys, keyLabel, type AskKeybinding, type AskKeybindings } from "../keys.js";

const remapped: AskKeybindings = {
	matches: (data, id) => data === ({
		"tui.select.up": "k", "tui.select.down": "j", "tui.select.confirm": "y", "tui.select.cancel": "q",
	} satisfies Record<AskKeybinding, string>)[id],
	getKeys: (id) => id === "tui.select.up" ? ["k"] : id === "tui.select.cancel" ? [] : ["enter"],
};

describe("key resolver", () => {
	it("uses injected keybindings, not defaults, for all select actions", () => {
		const keys = createAskKeys(remapped);
		expect(keys.resolve("k")).toEqual({ kind: "up" });
		expect(keys.resolve("j")).toEqual({ kind: "down" });
		expect(keys.resolve("y")).toEqual({ kind: "confirm" });
		expect(keys.resolve("q")).toEqual({ kind: "cancel" });
		expect(keys.resolve("\u001b[A")).toBeUndefined();
		expect(keys.resolve("\r")).toBeUndefined();
	});
	it.each([
		["\u001b[A", "up"], ["\u001b[B", "down"], ["\r", "confirm"], ["\u001b", "cancel"], ["\u0003", "cancel"],
	])("falls back to terminal defaults %j", (data, kind) => {
		expect(createAskKeys().resolve(data)).toEqual({ kind });
	});
	it.each([
		["\t", "nextTab"], ["\u001b[C", "nextTab"], ["\u001b[Z", "prevTab"], ["\u001b[D", "prevTab"],
		[" ", "toggle"], ["n", "noteOption"], ["N", "noteQuestion"], ["\u001b[110;2u", "noteQuestion"],
	])("fixed keys work with and without a manager %j", (data, kind) => {
		expect(createAskKeys().resolve(data)).toEqual({ kind });
		expect(createAskKeys(remapped).resolve(data)).toEqual({ kind });
	});
	it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])("maps raw digit %s", (n) => {
		expect(createAskKeys().resolve(String(n))).toEqual({ kind: "digit", n });
	});
	it.each(["0", "10", "x", ""])("ignores other input %j", (data) => {
		expect(createAskKeys().resolve(data)).toBeUndefined();
	});
});

describe("key labels", () => {
	it("shows manager labels and explicitly unbound actions", () => {
		const keys = createAskKeys(remapped);
		expect(keys.label("tui.select.up")).toBe("k");
		expect(keys.label("tui.select.confirm")).toBe("Enter");
		expect(keys.label("tui.select.cancel")).toBe("Unbound");
	});
	it("uses symbolic defaults without getKeys and joins multiple bindings", () => {
		const keys = createAskKeys({ matches: remapped.matches });
		expect(keys.label("tui.select.up")).toBe("↑");
		expect(keys.label("tui.select.down")).toBe("↓");
		expect(keys.label("tui.select.confirm")).toBe("Enter");
		expect(keys.label("tui.select.cancel")).toBe("Esc/ctrl+c");
		expect(createAskKeys({ matches: remapped.matches, getKeys: () => ["up", "k"] }).label("tui.select.up")).toBe("↑/k");
	});
	it.each([["left", "←"], ["right", "→"], ["shift+tab", "shift+tab"]])("labels fixed key %s", (key, label) => {
		expect(keyLabel(key)).toBe(label);
	});
});
