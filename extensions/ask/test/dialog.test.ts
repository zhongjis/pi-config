import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createAskDialog, type AskDialogResult } from "../dialog.js";
import type { AskKeybindings } from "../keys.js";
import { normalizeQuestions } from "../normalize.js";
import type { IncomingQuestion } from "../types.js";

vi.mock("@earendil-works/pi-tui", async () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
const question = (extra: Partial<IncomingQuestion> = {}): IncomingQuestion => ({ id: "q", label: "Scope", prompt: "Choose an approach", options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }], ...extra });
function setup(input = [question()], options: { signal?: AbortSignal; keybindings?: AskKeybindings; title?: string } = {}) {
	const done = vi.fn<(result: AskDialogResult) => void>();
	const tui = { requestRender: vi.fn(), terminal: { rows: 50, columns: 120 } };
	const dialog = createAskDialog({ questions: normalizeQuestions(input), input, tui: tui as never, theme, done, ...options });
	const text = (width = 120) => dialog.render(width).join("\n");
	const feed = (...keys: string[]) => keys.forEach((key) => { dialog.handleInput(key); });
	return { dialog, done, tui, text, feed };
}
const remapped: AskKeybindings = {
	matches: (data, id) => data === ({ "tui.select.up": "k", "tui.select.down": "j", "tui.select.confirm": "y", "tui.select.cancel": "q" })[id],
	getKeys: (id) => id === "tui.select.up" ? ["k"] : id === "tui.select.cancel" ? ["q"] : id === "tui.select.confirm" ? ["y"] : ["j"],
};

describe("ask dialog input and lifecycle", () => {
	it("forwards focus to Editor and emits its cursor marker only when focused", () => {
		const { dialog, text, feed } = setup();
		feed("N");
		dialog.focused = true;
		expect(dialog.focused).toBe(true);
		expect(text()).toContain(CURSOR_MARKER);
		dialog.focused = false;
		expect(text()).not.toContain(CURSOR_MARKER);
		dialog.dispose();
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
		expect(text()).toContain("k/j navigate");
		feed("k");
		expect(text()).toContain("> Other");
		feed("k", "y");
		expect(done.mock.calls[0][0].details.answers[0].values).toEqual(["b"]);
	});
	it("digit quickPick finalizes immediately without notes", () => {
		const { feed, done, text } = setup();
		expect(text()).not.toContain("✓ Review");
		expect(text()).toContain("1–9 select");
		feed("2");
		expect(done).toHaveBeenCalledTimes(1);
		expect(done.mock.calls[0][0].details).toMatchObject({ mode: "submit", cancelled: false, answers: [{ indices: [2], values: ["b"] }] });
	});
	it("renders option and question notes; Review 2 elaborates saved notes and answers", () => {
		const { feed, text, done } = setup();
		feed("n", "why Alpha?", "\r", "N", "what scope?", "\r");
		expect(text()).toContain("✎ why Alpha?");
		expect(text()).toContain("✎ what scope?");
		feed("1");
		expect(done).not.toHaveBeenCalled();
		expect(text()).toContain("✓ Review");
		expect(text()).toContain("1–3 action");
		feed("2");
		expect(done.mock.calls[0][0].details).toMatchObject({ mode: "elaborate", answers: [{ values: ["a"] }], notes: [
			{ questionId: "q", text: "what scope?" }, { questionId: "q", optionValue: "a", text: "why Alpha?" },
		] });
	});
	it("keeps cancelled editor drafts, prefills on reopen and uses bound editor cancel", () => {
		const { feed, text, done } = setup(undefined, { keybindings: remapped });
		feed("k", "y", "draft text", "q");
		expect(text()).toContain("draft: draft text");
		feed("y");
		expect(text()).toContain("draft text");
		feed("\r");
		expect(done.mock.calls[0][0].details.answers[0].customInput).toBe("draft text");
	});
	it("renders a bound dismiss notice, clears it on another key and guards twice", () => {
		const { feed, text, done } = setup([question({ multi: true })], { keybindings: remapped });
		feed("1", "q");
		expect(text()).toContain("Press q again to discard your answers");
		expect(done).not.toHaveBeenCalled();
		feed("x");
		expect(text()).not.toContain("Press q again");
		feed("q", "q");
		expect(done).toHaveBeenCalledTimes(1);
		expect(done.mock.calls[0][0].details.cancelled).toBe(true);
	});
	it("renders mixed multi custom, Other draft and advisory required; Review submits partial", () => {
		const { feed, text, done } = setup([question({ multi: true, required: true }), question({ id: "next", label: "Next", required: true })]);
		expect(text()).toContain("□ Scope*");
		feed("1", "\u001b[A", "\r", "extra", "\r");
		expect(text()).toContain("☑ 1. Alpha");
		expect(text()).toContain("☑ Other (type your own): extra");
		feed(" ");
		expect(text()).toContain("draft: extra");
		feed(" ", "\t", "\t");
		expect(text()).toContain("Next: (no answer) [required]");
		expect(text()).toContain("2 Elaborate (add a note first: n / N)");
		feed("2");
		expect(done).not.toHaveBeenCalled();
		feed("1");
		expect(done.mock.calls[0][0].details.answers).toHaveLength(1);
		expect(done.mock.calls[0][0].details.answers[0]).toMatchObject({ values: ["a"], customInput: "extra" });
	});
});

describe("ask dialog preview and widths", () => {
	it("uses wide columns, narrow box, cursor previews, missing preview and line cap", () => {
		const preview = Array.from({ length: 20 }, (_, i) => `code ${i}`).join("\n");
		const { text, feed, dialog } = setup([question({ options: [{ value: "a", label: "Alpha", preview }, { value: "b", label: "Beta" }] })]);
		expect(text(120)).toContain(" │ Preview");
		expect(text(120)).toContain("… +8 more lines");
		expect(text(80)).toContain("┌");
		expect(text(80)).toContain("Preview");
		feed("\u001b[B");
		expect(text()).toContain("(no preview)");
		dialog.dispose();
	});
	it("wraps preview text to its column rather than dropping long text", () => {
		const { text, dialog } = setup([question({ options: [{ value: "a", label: "A", preview: "start " + "word ".repeat(25) + "end" }] })]);
		expect(text(120)).toContain("start");
		expect(text(120)).toContain("end");
		dialog.dispose();
	});
	it("every line fits widths 20..200 across title, notes, multi, preview, review, editor and dismiss", () => {
		const input = [question({ multi: true, required: true, prompt: "中文🙂 é " + "prompt ".repeat(30), options: [
			{ value: "a", label: "中文🙂".repeat(30), description: "description ".repeat(30), preview: "中文🙂 code\n".repeat(20) },
			{ value: "b", label: "Beta" },
		] }), question({ id: "next", required: true })];
		const { dialog, feed } = setup(input, { title: "中文🙂 title ".repeat(20) });
		const check = () => {
			for (let width = 20; width <= 200; width++) for (const line of dialog.render(width)) {
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
		feed("\u001b", "\t", "\t");
		check();
		dialog.invalidate();
		check();
		dialog.dispose();
	});
});
