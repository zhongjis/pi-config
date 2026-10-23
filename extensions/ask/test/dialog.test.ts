import { type AutocompleteProvider, CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createAskAutocompleteProvider } from "../autocomplete.js";
import { createAskDialog, type AskDialogResult } from "../dialog.js";
import type { AskKeybindings } from "../keys.js";
import { normalizeQuestions } from "../normalize.js";
import type { IncomingQuestion } from "../types.js";

vi.mock("@earendil-works/pi-tui", async () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text };
const question = (extra: Partial<IncomingQuestion> = {}): IncomingQuestion => ({ id: "q", label: "Scope", prompt: "Choose an approach", options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }], ...extra });
function setup(input = [question()], options: { signal?: AbortSignal; keybindings?: AskKeybindings; title?: string; autocompleteProvider?: AutocompleteProvider } = {}) {
	const done = vi.fn<(result: AskDialogResult) => void>();
	const tui = { requestRender: vi.fn(), terminal: { rows: 50, columns: 120 } };
	const dialog = createAskDialog({ questions: normalizeQuestions(input), input, tui: tui as never, theme, done, ...options });
	const text = (width = 120) => dialog.render(width).join("\n");
	const feed = (...keys: string[]) => keys.forEach((key) => { dialog.handleInput(key); });
	return { dialog, done, tui, text, feed };
}
const remapped: AskKeybindings = {
	matches: (data, id) => data === ({ "tui.select.up": "k", "tui.select.down": "j", "tui.select.confirm": "y", "tui.select.cancel": "q", "tui.input.submit": "y" })[id],
	getKeys: (id) => id === "tui.select.up" ? ["k"] : id === "tui.select.cancel" ? ["q"] : id === "tui.select.confirm" ? ["y"] : ["j"],
};

describe("ask dialog input and lifecycle", () => {
	it("forwards focus to the Editor and emits its cursor marker only when focused", () => {
		const { dialog, text, feed } = setup();
		feed("N");
		dialog.focused = true;
		expect(dialog.focused).toBe(true);
		expect(text()).toContain(CURSOR_MARKER);
		dialog.focused = false;
		expect(text()).not.toContain(CURSOR_MARKER);
		dialog.dispose();
	});
	it("Escape closes completion before keeping the editor draft", async () => {
		const autocompleteProvider = createAskAutocompleteProvider(process.cwd(), [{ name: "skill:implement", description: "Build it", source: "skill" }]);
		const { feed, text, done, dialog } = setup(undefined, { autocompleteProvider });
		feed("N", "$");
		await vi.waitFor(() => expect(text()).toContain("Build it"));
		feed("\u001b");
		expect(text()).not.toContain("Build it");
		expect(text()).toContain("Enter save · Esc keep draft");
		feed("\u001b");
		expect(text()).not.toContain("keep draft");
		feed("N");
		expect(text()).toContain("$");
		feed("\r", "1", "1");
		expect(done.mock.calls[0][0].details.notes[0].text).toBe("$");
		dialog.dispose();
	});
	it.each(["\r", "\t"])("%j applies completion after arrow selection without saving the answer", async (accept) => {
		const autocompleteProvider = createAskAutocompleteProvider(process.cwd(), [
			{ name: "skill:implement", description: "Build it", source: "skill" },
			{ name: "skill:inspect", description: "Inspect it", source: "skill" },
		]);
		const { feed, text, done } = setup(undefined, { autocompleteProvider });
		feed("\u001b[A", "\r", "$");
		await vi.waitFor(() => expect(text()).toContain("Build it"));
		feed("\u001b[B", "\u001b[A", "\u001b[B", accept);
		expect(done).not.toHaveBeenCalled();
		expect(text()).toContain("$skill:inspect ");
		expect(text()).toContain("Enter save · Esc keep draft");
		feed("\r");
		expect(done.mock.calls[0][0].details.answers[0].customInput).toBe("$skill:inspect");
	});
	it("cancels pending completion when disposed", async () => {
		let requestSignal: AbortSignal | undefined;
		const autocompleteProvider: AutocompleteProvider = {
			triggerCharacters: ["$"],
			getSuggestions: (_lines, _line, _col, { signal }) => new Promise((resolve) => {
				requestSignal = signal;
				signal.addEventListener("abort", () => resolve(null), { once: true });
			}),
			applyCompletion: () => { throw new Error("No completion to apply"); },
		};
		const { feed, dialog } = setup(undefined, { autocompleteProvider });
		feed("N", "$");
		await vi.waitFor(() => expect(requestSignal).toBeDefined());
		dialog.dispose();
		expect(requestSignal!.aborted).toBe(true);
	});
	it("keeps multiline notes and custom answers intact through Review and submission", () => {
		const { feed, text, done } = setup();
		feed("N", "first", "\n", "second", "\r", "\u001b[A", "\r", "own", "\n", "answer", "\r");
		expect(text()).toContain("first");
		expect(text()).toContain("second");
		expect(text()).toContain("“own\n");
		feed("1");
		expect(done.mock.calls[0][0].details).toMatchObject({ answers: [{ customInput: "own\nanswer" }], notes: [{ text: "first\nsecond" }] });
	});
	it("abort completes once as aborted and removes the listener", () => {
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const { feed, done } = setup(undefined, { signal: controller.signal });
		feed("N", "unfinished");
		controller.abort();
		feed("1", "\u001b");
		controller.abort();
		expect(done).toHaveBeenCalledTimes(1);
		expect(done.mock.calls[0][0]).toMatchObject({ aborted: true, details: { cancelled: true, mode: "submit" } });
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
	});
	it("normal completion and disposal remove abort listeners too", () => {
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const first = setup(undefined, { signal: controller.signal });
		first.feed("1");
		controller.abort();
		expect(first.done).toHaveBeenCalledTimes(1);
		expect(first.done.mock.calls[0][0].aborted).toBe(false);
		expect(remove).toHaveBeenCalled();
		const other = new AbortController();
		const disposed = setup(undefined, { signal: other.signal });
		disposed.dialog.dispose();
		other.abort();
		expect(disposed.done).not.toHaveBeenCalled();
	});
	it("handles a signal already aborted when the factory is constructed", () => {
		const controller = new AbortController();
		controller.abort();
		const { done } = setup(undefined, { signal: controller.signal });
		expect(done).toHaveBeenCalledTimes(1);
		expect(done.mock.calls[0][0].aborted).toBe(true);
	});
	it("uses remapped select keys and their hint labels", () => {
		const { feed, text, done } = setup(undefined, { keybindings: remapped });
		expect(text()).toContain("k/j move");
		expect(text()).toContain("y submit");
		feed("k");
		expect(text()).toMatch(/› +Other…/);
		expect(text()).toContain("y type");
		feed("k", "y");
		expect(done.mock.calls[0][0].details.answers[0].values).toEqual(["b"]);
	});
	it("digit quickPick finalizes immediately without notes", () => {
		const { feed, done, text } = setup();
		expect(text()).toContain("□ Scope      Review");
		expect(text()).not.toContain("Tab next");
		expect(text()).toContain("↑↓ move · 1–2 pick · Enter submit · n/N note · Esc cancel");
		feed("2");
		expect(done).toHaveBeenCalledTimes(1);
		expect(done.mock.calls[0][0].details).toMatchObject({ mode: "submit", cancelled: false, answers: [{ indices: [2], values: ["b"] }] });
	});
	it("renders option and question notes; Review 2 elaborates saved notes and answers", () => {
		const { feed, text, done } = setup();
		feed("n", "why Alpha?", "\r", "N", "what scope?", "\r");
		expect(text()).toContain("✎ why Alpha?");
		expect(text()).toContain("✎ what scope?");
		expect(text()).toContain("Enter review");
		feed("1");
		expect(done).not.toHaveBeenCalled();
		expect(text()).toContain("Review");
		expect(text()).toContain("↑↓ move · 1–3 action · Enter run · Tab back · Esc cancel");
		expect(text()).toMatch(/Scope +Alpha/);
		expect(text()).toContain("✎ what scope?");
		expect(text()).toContain("✎ Alpha: why Alpha?");
		feed("2");
		expect(done.mock.calls[0][0].details).toMatchObject({ mode: "elaborate", answers: [{ values: ["a"] }], notes: [
			{ questionId: "q", text: "what scope?" }, { questionId: "q", optionValue: "a", text: "why Alpha?" },
		] });
	});
	it("keeps cancelled editor drafts, prefills on reopen and uses bound editor cancel", () => {
		const { feed, text, done } = setup(undefined, { keybindings: remapped });
		feed("k", "y", "draft text", "q");
		expect(text()).toContain("Other  draft “draft text”");
		feed("y");
		expect(text()).toContain("draft text");
		feed("\r");
		expect(done.mock.calls[0][0].details.answers[0].customInput).toBe("draft text");
	});
	it("renders a bound dismiss notice, clears it on another key and guards twice", () => {
		const { feed, text, done } = setup([question({ multi: true })], { keybindings: remapped });
		feed("1", "q");
		expect(text()).toContain("q again discards your answers · any other key keeps them");
		expect(done).not.toHaveBeenCalled();
		feed("x");
		expect(text()).not.toContain("q again");
		feed("q", "q");
		expect(done).toHaveBeenCalledTimes(1);
		expect(done.mock.calls[0][0].details.cancelled).toBe(true);
	});
	it("renders mixed multi custom, Other draft and advisory required; Review submits partial", () => {
		const { feed, text, done } = setup([question({ multi: true, required: true }), question({ id: "next", label: "Next", required: true })]);
		expect(text()).toContain("□ Scope*");
		expect(text()).toContain("0/2 answered");
		expect(text()).toContain("1–2/Space toggle · Enter next");
		feed("1", "\u001b[A", "\r", "extra", "\r");
		expect(text()).toContain("■ Scope ");
		expect(text()).toContain("1/2 answered");
		expect(text()).toContain("☑ 1  Alpha");
		expect(text()).toMatch(/☑ +Other {2}“extra”/);
		feed(" ");
		expect(text()).toMatch(/☐ +Other {2}draft “extra”/);
		feed(" ", "\t", "\t");
		expect(text()).toMatch(/Scope +Alpha, “extra”/);
		expect(text()).toMatch(/Next +! no answer · required/);
		expect(text()).toContain("› 1  Submit  · 1 required unanswered");
		expect(text()).toContain("2  Elaborate  add a note first (n/N)");
		feed("2");
		expect(done).not.toHaveBeenCalled();
		feed("1");
		expect(done.mock.calls[0][0].details.answers).toHaveLength(1);
		expect(done.mock.calls[0][0].details.answers[0]).toMatchObject({ values: ["a"], customInput: "extra" });
	});
});

describe("ask dialog preview and widths", () => {
	it("uses wide columns, a narrow preview rule, cursor previews, missing preview and line cap", () => {
		const preview = Array.from({ length: 20 }, (_, i) => `code ${i}`).join("\n");
		const { text, feed, dialog } = setup([question({ options: [{ value: "a", label: "Alpha", preview }, { value: "b", label: "Beta" }] })]);
		expect(text(120)).toContain(" │ Preview · Alpha");
		expect(text(120)).toContain("code 10");
		expect(text(120)).not.toContain("code 11");
		expect(text(120)).toContain("… +9 more lines");
		expect(text(80)).toContain("── Preview · Alpha ──");
		expect(text(80)).not.toContain("┌");
		feed("\u001b[B");
		expect(text()).toContain("Preview · Beta");
		expect(text()).toContain("no preview");
		dialog.dispose();
	});
	it("keeps the dialog height fixed while the cursor crosses previews of different lengths", () => {
		const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
		const { dialog, feed } = setup([question({ options: [
			{ value: "a", label: "Alpha", preview: lines(2) }, { value: "b", label: "Beta", preview: lines(7) }, { value: "c", label: "Gamma" },
		] })]);
		for (const width of [60, 120]) {
			const heights = new Set<number>();
			for (let i = 0; i < 4; i++) {
				heights.add(dialog.render(width).length);
				feed("\u001b[B");
			}
			expect(heights.size, `width ${width}`).toBe(1);
		}
		dialog.dispose();
	});
	it("edits notes and Other beneath their rows while the options stay visible", () => {
		const { dialog, text, feed } = setup([question({ options: [{ value: "a", label: "Alpha", description: "First" }, { value: "b", label: "Beta" }] })]);
		feed("n", "why");
		expect(text()).toMatch(/First\n.*✎\n.*─\n.*why/);
		expect(text()).toContain("Beta");
		expect(text()).toContain("Enter save · Esc keep draft");
		feed("\r", "N", "scope");
		expect(text()).toMatch(/Choose an approach\n.*✎\n.*─\n.*scope/);
		feed("\u001b", "\u001b[A", "\r", "own");
		expect(text()).toMatch(/Other\n.*─\n.*own/);
		expect(text()).toContain("Alpha");
		dialog.dispose();
	});
	it("frames questions and Review between full-width rules: header, gap, tab row, gap, body, gap, hints", () => {
		const { text, feed } = setup([question(), question({ id: "next" })], { title: "Plan" });
		const rule = "─".repeat(60);
		const frame = (lines: string[]) => {
			expect(lines[0]).toBe(rule);
			expect(lines[1]).toMatch(/^ Plan +0\/2 answered$/);
			expect(visibleWidth(lines[1])).toBe(59);
			expect(lines[2]).toBe("");
			expect(lines[3]).toMatch(/^ □ Scope {3}□ Scope {6}Review $/);
			expect(lines[4]).toBe("");
			expect(lines.at(-3)).toBe("");
			expect(lines.at(-1)).toBe(rule);
		};
		const lines = text(60).split("\n");
		frame(lines);
		expect(lines[5]).toBe(" Choose an approach");
		expect(lines.at(-2)).toMatch(/^ ↑↓ move · .* Esc cancel$/);
		expect(text(60)).not.toMatch(/[│╭╮╰╯]/);
		feed("\t", "\t");
		const review = text(60).split("\n");
		frame(review);
		expect(review[5]).toMatch(/^ Scope +— no answer$/);
		expect(review.at(-2)).toMatch(/^ ↑↓ move · 1–3 action · .* Esc cancel$/);
	});
	it("drops progress before truncating the title", () => {
		const { text } = setup([question(), question({ id: "next" })], { title: "A long planning title" });
		expect(text(40).split("\n")[1]).toMatch(/^ A long planning title +0\/2 answered$/);
		expect(text(30).split("\n")[1]).toBe(" A long planning title");
		expect(text(12).split("\n")[1]).not.toContain("answered");
		expect(setup([question(), question({ id: "next" })]).text(40).split("\n")[1]).toMatch(/^ ask +0\/2 answered$/);
	});
	it("single-select always shows tabs before the prompt, with or without a title", () => {
		const bare = setup().text(60).split("\n");
		expect(bare[0]).toBe("─".repeat(60));
		expect(bare[1]).toBe(" □ Scope      Review ");
		expect(bare[2]).toBe("");
		expect(bare[3]).toBe(" Choose an approach");
		expect(bare[5]).toMatch(/^ › 1 {2}Alpha$/);
		expect(bare.at(-2)).toBe(" ↑↓ move · 1–2 pick · Enter submit · n/N note · Esc cancel");
		const titled = setup(undefined, { title: "Plan" }).text(60).split("\n");
		expect(titled.slice(0, 6)).toEqual(["─".repeat(60), " Plan", "", " □ Scope      Review ", "", " Choose an approach"]);
	});
	it("caps the content area at 140 columns while the rules span the full width", () => {
		const lines = setup([question(), question({ id: "next" })], { title: "Plan" }).text(320).split("\n");
		expect(lines[0]).toBe("─".repeat(320));
		expect(lines.at(-1)).toBe("─".repeat(320));
		expect(lines[1]).toMatch(/answered$/);
		expect(visibleWidth(lines[1])).toBe(139);
		for (const line of lines.slice(1, -1)) expect(visibleWidth(line)).toBeLessThanOrEqual(139);
	});
	it("wraps preview text to its column rather than dropping long text", () => {
		const { text, dialog } = setup([question({ options: [{ value: "a", label: "A", preview: "start " + "word ".repeat(25) + "end" }] })]);
		expect(text(120)).toContain("start");
		expect(text(120)).toContain("end");
		dialog.dispose();
	});
	it("every line fits widths 0..8, 20..200 and 320 across title, notes, multi, preview, review, editor and dismiss", () => {
		const input = [question({ multi: true, required: true, prompt: "中文🙂 é " + "prompt ".repeat(30), options: [
			{ value: "a", label: "中文🙂".repeat(30), description: "description ".repeat(30), preview: "中文🙂 code\n".repeat(20) },
			{ value: "b", label: "Beta" },
		] }), question({ id: "next", required: true })];
		const { dialog, feed } = setup(input, { title: "中文🙂 title ".repeat(20) });
		const check = () => {
			for (const width of [0, 1, 2, 8, ...Array.from({ length: 181 }, (_, i) => i + 20), 320]) for (const line of dialog.render(width)) {
				expect(visibleWidth(line), `${JSON.stringify(line)} at ${width}`).toBeLessThanOrEqual(width);
			}
		};
		check();
		feed("n", "note ".repeat(30), "\r", "N", "question note ".repeat(20), "\r", "1");
		check();
		feed("\u001b");
		check();
		feed("x", "\u001b[A", "\r", "draft ".repeat(40));
		dialog.focused = true;
		check();
		feed("\u001b", "n", "inline ".repeat(40));
		check();
		feed("\u001b", "\t", "\t");
		check();
		dialog.invalidate();
		check();
		dialog.dispose();
	});
});
