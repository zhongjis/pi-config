import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createAskAutocompleteProvider } from "../autocomplete.js";

vi.mock("@earendil-works/pi-tui", async () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

const commands: Parameters<typeof createAskAutocompleteProvider>[1] = [
	{ name: "skill:implement", description: "Build it", source: "skill" },
	{ name: "skill:inspect", description: "Inspect it", source: "skill" },
	{ name: "skill:ignored", description: "Not a skill", source: "extension" },
	{ name: "not-a-skill", source: "skill" },
];
const options = () => ({ signal: new AbortController().signal });
const provider = () => createAskAutocompleteProvider(process.cwd(), commands);

describe("ask autocomplete", () => {
	it.each(["$", "$skill:", "$skill:imp", "$imp", "($skill:imp", "[$skill:imp", "{$skill:imp", ",$skill:imp", "text $skill:imp"])("suggests native skills at token starts: %s", async (text) => {
		const suggestions = await provider().getSuggestions([text], 0, text.length, options());
		expect(suggestions?.items[0]).toEqual({ value: "$skill:implement", label: "implement", description: "Build it" });
		expect(suggestions?.items.some((item) => item.label === "ignored")).toBe(false);
		expect(suggestions?.items.some((item) => item.label === "not-a-skill")).toBe(false);
		expect(suggestions?.items.length).toBe(text === "$" || text === "$skill:" ? 2 : 1);
		expect(suggestions?.prefix).toBe(text.slice(text.lastIndexOf("$")));
	});
	it.each(["word$skill:imp", "$graph:", "$graph:imp", "$skill:missing"])("does not suggest skills for %s", async (text) => {
		expect(await provider().getSuggestions([text], 0, text.length, options())).toBeNull();
	});
	it("replaces only the token before the cursor, preserving other lines and the suffix", async () => {
		const p = provider();
		const lines = ["first line", "use ($skill:imp) now"];
		const cursorCol = lines[1].indexOf(")");
		const suggestions = await p.getSuggestions(lines, 1, cursorCol, options());
		expect(p.applyCompletion(lines, 1, cursorCol, suggestions!.items[0], suggestions!.prefix)).toEqual({
			lines: ["first line", "use ($skill:implement ) now"], cursorLine: 1, cursorCol: "use ($skill:implement ".length,
		});
		expect(lines[1]).toBe("use ($skill:imp) now");
		expect(p.triggerCharacters).toEqual(["@", "$"]);
	});
	it("delegates file suggestions, application and trigger detection to pi-tui", async () => {
		const p = provider();
		const item = { value: "@src/file.ts", label: "file.ts" };
		const suggestions = { items: [item], prefix: "@src/f" };
		const result = { lines: ["@src/file.ts "], cursorLine: 0, cursorCol: 13 };
		const get = vi.spyOn(CombinedAutocompleteProvider.prototype, "getSuggestions").mockResolvedValue(suggestions);
		const apply = vi.spyOn(CombinedAutocompleteProvider.prototype, "applyCompletion").mockReturnValue(result);
		const trigger = vi.spyOn(CombinedAutocompleteProvider.prototype, "shouldTriggerFileCompletion").mockReturnValue(true);
		try {
			const opts = options();
			expect(await p.getSuggestions(["@src/f"], 0, 6, opts)).toBe(suggestions);
			expect(get).toHaveBeenCalledWith(["@src/f"], 0, 6, opts);
			expect(p.applyCompletion(["@src/f"], 0, 6, item, suggestions.prefix)).toBe(result);
			expect(apply).toHaveBeenCalledWith(["@src/f"], 0, 6, item, suggestions.prefix);
			expect(p.shouldTriggerFileCompletion?.(["@src/f"], 0, 6)).toBe(true);
			expect(trigger).toHaveBeenCalledWith(["@src/f"], 0, 6);
		} finally {
			get.mockRestore();
			apply.mockRestore();
			trigger.mockRestore();
		}
	});
	it("finds and applies a real file through fd on PATH", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "ask-completion-"));
		try {
			writeFileSync(join(cwd, "completion-proof.txt"), "fixture");
			const p = createAskAutocompleteProvider(cwd, []);
			const text = "@completion-proof";
			const suggestions = await p.getSuggestions([text], 0, text.length, options());
			const item = suggestions?.items.find((item) => item.value.includes("completion-proof.txt"));
			expect(item).toBeDefined();
			const result = p.applyCompletion([text], 0, text.length, item!, suggestions!.prefix);
			expect(result.lines[0]).toContain("@completion-proof.txt");
			expect(result.cursorCol).toBe(result.lines[0].length);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});
});
