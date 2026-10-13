import { describe, expect, it } from "vitest";
import { displayValue, formatAnswerLine, formatInvalidPayload, formatNonTuiQuestions, formatResultText } from "../format.js";
import { normalizeQuestions } from "../normalize.js";
import type { Answer, AskDetails } from "../types.js";

const input = [
	{ id: "q1", label: "Scope", prompt: "How much?", options: [
		{ value: "a", label: "Alpha", description: "First" },
		{ value: "same", label: "same" },
		{ value: "c", label: "Charlie" },
	] },
	{ id: "q2", label: "Next", prompt: "What next?", options: [{ value: "x", label: "X" }], multi: true, required: true, allowOther: false },
];
const qs = normalizeQuestions(input);
const q = qs[0];
const selected: Answer = { id: "q1", multi: false, wasCustom: false, values: ["a"], labels: ["Alpha"], indices: [1] };
const custom: Answer = { id: "q1", multi: false, wasCustom: true, values: [], labels: [], indices: [], customInput: "hello" };
function details(extra: Partial<AskDetails> = {}): AskDetails {
	return { questions: input, answers: [selected], notes: [], cancelled: false, mode: "submit", ...extra };
}

describe("displayValue", () => {
	it("prefers value when different and label when equal", () => {
		expect(displayValue("a", "Alpha")).toBe("a");
		expect(displayValue("same", "same")).toBe("same");
	});
});

describe("formatAnswerLine", () => {
	it("reports no answer with advisory required only when unanswered", () => {
		expect(formatAnswerLine(q, undefined)).toBe("Scope: (no answer)");
		expect(formatAnswerLine({ ...q, required: true }, undefined)).toBe("Scope: (no answer) [required]");
		expect(formatAnswerLine({ ...q, required: true }, selected)).toBe("Scope: user selected: 1. a");
	});
	it("reports custom-only answer and empty answer", () => {
		expect(formatAnswerLine(q, custom)).toBe("Scope: user wrote: hello");
		expect(formatAnswerLine(q, { ...selected, values: [], labels: [], indices: [] })).toBe("Scope: (no answer)");
	});
	it("single selected uses index and display value", () => {
		expect(formatAnswerLine(q, selected)).toBe("Scope: user selected: 1. a");
		expect(formatAnswerLine(q, { ...selected, values: ["same"], labels: ["same"], indices: [2] })).toBe("Scope: user selected: 2. same");
	});
	it("multi joins options and appends mixed custom", () => {
		const multi: Answer = { ...selected, multi: true, values: ["a", "c"], labels: ["Alpha", "Charlie"], indices: [1, 3] };
		expect(formatAnswerLine(q, multi)).toBe("Scope: user selected: 1. a, 3. c");
		expect(formatAnswerLine(q, { ...multi, wasCustom: true, customInput: "extra" })).toBe("Scope: user selected: 1. a, 3. c; user wrote: extra");
		expect(formatAnswerLine(q, { ...custom, multi: true })).toBe("Scope: user wrote: hello");
		expect(formatAnswerLine(q, { ...multi, values: ["a", "same"], labels: ["Alpha", "same"], indices: [1, 2] })).toBe("Scope: user selected: 1. a, 2. same");
	});
});

describe("result text", () => {
	it("submit includes title and every question in order", () => {
		expect(formatResultText(qs, details({ title: "Decisions" }))).toBe("Decisions\nScope: user selected: 1. a\nNext: (no answer) [required]");
	});
	it("notes include question and option displays in question order", () => {
		const text = formatResultText(qs, details({ notes: [
			{ questionId: "q2", text: "later?" },
			{ questionId: "q1", text: "scope?" },
			{ questionId: "q1", optionValue: "a", text: "why?" },
		] }));
		expect(text).toBe("Scope: user selected: 1. a\nNext: (no answer) [required]\nNotes:\n- Scope: scope?\n- Scope › 1. a: why?\n- Next: later?");
	});
	it("elaborate marks the mode and retains answers, notes and title", () => {
		const text = formatResultText(qs, details({ mode: "elaborate", title: "Decisions", notes: [{ questionId: "q1", text: "explain" }] }));
		expect(text).toContain("(mode: elaborate)");
		expect(text.endsWith([
			"Decisions", "Scope: user selected: 1. a", "Next: (no answer) [required]", "Notes:", "- Scope: explain",
		].join("\n"))).toBe(true);
		expect(formatResultText(qs, details({ title: "Decisions" }))).not.toContain("(mode: elaborate)");
	});
	it("cancelled and aborted have distinct messages", () => {
		expect(formatResultText(qs, details({ cancelled: true }))).toBe("User cancelled the questions.");
		expect(formatResultText(qs, details({ cancelled: true }), true)).toBe("Ask was aborted before the user answered.");
	});
	it("invalid payload lists every structured issue", () => {
		const issues = [{ path: "questions[0].id", message: "Blank" }, { path: "questions[1].options", message: "Empty" }];
		const text = "Invalid ask payload:\n- questions[0].id: Blank\n- questions[1].options: Empty";
		expect(formatInvalidPayload(issues)).toBe(text);
		expect(formatResultText([], details({ cancelled: true, error: { issues } }))).toBe(text);
	});
});

describe("non-TUI question list", () => {
	it("lists prompts, select modes, labels, descriptions and allowed Other", () => {
		expect(formatNonTuiQuestions(qs)).toBe([
			"Needs user input: the ask tool requires interactive TUI mode. Ask the user these questions directly:",
			"1. Scope: How much? (choose one)", "   1. Alpha — First", "   2. same", "   3. Charlie", "   Other: free text allowed",
			"2. Next: What next? (choose any)", "   1. X",
		].join("\n"));
	});
});
