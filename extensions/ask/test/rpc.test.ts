import { describe, expect, it } from "vitest";
import { formatResultText } from "../format.js";
import { normalizeQuestions } from "../normalize.js";
import { ADD_NOTE, askViaDialogs, CANCEL, DONE, EDIT_NOTE, ELABORATE, OTHER, PREVIEWS, SKIP, SUBMIT, type DialogUI } from "../rpc.js";
import type { IncomingQuestion } from "../types.js";

type Call = { method: "select" | "input" | "editor"; title: string; options?: string[]; prefill?: string };
type Reply = string | undefined | ((call: Call) => string | undefined);

/** Scripted dialog client: each dialog call consumes the next reply. */
function scripted(replies: Reply[]) {
	const calls: Call[] = [];
	const next = (call: Call) => {
		calls.push(call);
		if (replies.length === 0) throw new Error(`unexpected ${call.method}: ${call.title}`);
		const reply = replies.shift();
		return Promise.resolve(typeof reply === "function" ? reply(call) : reply);
	};
	const ui: DialogUI = {
		select: (title, options) => next({ method: "select", title, options }),
		input: (title) => next({ method: "input", title }),
		editor: (title, prefill) => next({ method: "editor", title, prefill }),
	};
	return { ui, calls, remaining: () => replies.length };
}

const scope: IncomingQuestion = {
	id: "scope", label: "Scope", prompt: "Which scope?", recommended: 0,
	options: [{ value: "src", label: "Source", description: "Source files", preview: "src/**" }, { value: "all", label: "All" }],
};
const tags: IncomingQuestion = { id: "tags", label: "Tags", prompt: "Which tags?", multi: true, required: true, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] };

async function run(input: IncomingQuestion[], replies: Reply[], title?: string, signal?: AbortSignal) {
	const client = scripted(replies);
	const questions = normalizeQuestions(input);
	const details = await askViaDialogs(client.ui, questions, input, title, signal);
	expect(client.remaining()).toBe(0);
	return { ...client, details, text: formatResultText(questions, details, details.aborted === true) };
}

describe("askViaDialogs", () => {
	it("quick-picks one single-select question with one numbered select and TUI-identical text", async () => {
		const { calls, details, text } = await run([scope], ["1. Source — Source files (recommended)"], "Decisions");
		expect(calls).toEqual([{ method: "select", title: "Scope: Which scope?", options: [
			"1. Source — Source files (recommended)", "2. All", OTHER, PREVIEWS, ADD_NOTE,
		] }]);
		expect(text).toBe("Decisions\nScope: user selected: 1. src");
		expect(details).toMatchObject({ cancelled: false, mode: "submit", notes: [], answers: [{ id: "scope", indices: [1], values: ["src"], labels: ["Source"], wasCustom: false }] });
		expect(details.aborted).toBeUndefined();
	});

	it("toggles multi-select rows, adds Other text, skips a single question and submits from Review", async () => {
		const { calls, details, text } = await run([scope, tags], [
			SKIP,
			"☐ 2. B", "☐ 1. A", "☑ 2. B", OTHER, "custom tag", DONE,
			(call) => { expect(call.title).toBe("Review\nScope: (no answer)\nTags: A, “custom tag”"); return SUBMIT; },
		]);
		expect(calls[0].options).toContain(SKIP);
		expect(calls[1].title).toBe("Tags: Which tags? [required]");
		expect(calls[1].options).toEqual(["☐ 1. A", "☐ 2. B", OTHER, ADD_NOTE, DONE]);
		expect(calls[3].options?.slice(0, 2)).toEqual(["☑ 1. A", "☑ 2. B"]);
		expect(calls.at(-1)?.options).toEqual([SUBMIT, CANCEL]);
		expect(details.answers).toEqual([{ id: "tags", multi: true, wasCustom: true, values: ["a"], labels: ["A"], indices: [1], customInput: "custom tag" }]);
		expect(text).toBe("Scope: (no answer)\nTags: user selected: 1. a; user wrote: custom tag");
	});

	it("shows previews in a read-only editor, then a note on a quick-pick question opens Review with Elaborate", async () => {
		const { calls, details, text } = await run([scope], [
			PREVIEWS, "ignored edits",
			ADD_NOTE, "  why src?  ",
			(call) => { expect(call.options).toContain(EDIT_NOTE); return "2. All"; },
			(call) => { expect(call.options).toEqual([SUBMIT, ELABORATE, CANCEL]); return ELABORATE; },
		]);
		expect(calls[1]).toEqual({ method: "editor", title: "Previews — Scope", prefill: "1. Source\nsrc/**\n\n2. All\n(no preview)" });
		expect(calls[3]).toMatchObject({ method: "editor", title: "Note — Scope", prefill: "" });
		expect(details).toMatchObject({ mode: "elaborate", cancelled: false, notes: [{ questionId: "scope", text: "why src?" }], answers: [{ values: ["all"] }] });
		expect(text).toContain("(mode: elaborate)");
		expect(text).toContain("Notes:\n- Scope: why src?");
	});

	it("keeps asking when Other input or note editor is dismissed", async () => {
		const { details } = await run([scope], [OTHER, undefined, ADD_NOTE, undefined, OTHER, "mine"]);
		expect(details).toMatchObject({ cancelled: false, mode: "submit", notes: [], answers: [{ wasCustom: true, values: [], customInput: "mine" }] });
	});

	it("dismissing a question or Review cancels the whole ask", async () => {
		expect((await run([scope], [undefined])).text).toBe("User cancelled the questions.");
		const review = await run([scope, tags], ["2. All", DONE, CANCEL]);
		expect(review.details).toMatchObject({ cancelled: true, mode: "submit" });
		expect(review.details.answers).toEqual([expect.objectContaining({ id: "scope" })]);
	});

	it("an abort during a dialog returns aborted details", async () => {
		const controller = new AbortController();
		const { details, text } = await run([scope], [() => { controller.abort(); return undefined; }], undefined, controller.signal);
		expect(details).toMatchObject({ cancelled: true, aborted: true });
		expect(text).toBe("Ask was aborted before the user answered.");
	});
});
