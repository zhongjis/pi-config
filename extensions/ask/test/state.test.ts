import { describe, expect, it } from "vitest";
import { normalizeQuestions } from "../normalize.js";
import { AskState, type EditorTarget, type KeyEvent } from "../state.js";
import type { IncomingQuestion } from "../types.js";

const opt = (value: string, label = value) => ({ value, label });
const question = (extra: Partial<IncomingQuestion> = {}): IncomingQuestion => ({
	id: "q1", prompt: "p", options: [opt("a", "Alpha"), opt("b"), opt("c")], ...extra,
});
const make = (extra: Partial<IncomingQuestion> = {}, count = 1) => new AskState(normalizeQuestions(
	Array.from({ length: count }, (_, i) => question({ ...extra, id: `q${i + 1}` })),
));
const custom: EditorTarget = { kind: "custom", questionId: "q1" };
const note: EditorTarget = { kind: "note", questionId: "q1" };
const optionNote: EditorTarget = { kind: "note", questionId: "q1", optionIndex: 0 };
const submit = { kind: "finalize", result: { mode: "submit" } };
const cancel = { kind: "finalize", result: { cancelled: true } };
function openCustom(s: AskState) {
	s.optionIndex = 3;
	return s.dispatch({ kind: "confirm" });
}
function saveNote(s: AskState, text = "why?") {
	s.dispatch({ kind: "noteQuestion" });
	s.submitEditor(text);
}

describe("tabs and cursors", () => {
	it.each([[false, 1, true], [true, 1, false], [false, 3, false]])("always has Review; quickPick only for one single (%s, %s)", (multi, count, quickPick) => {
		const s = make({ multi }, count);
		expect(s.totalTabs).toBe(count + 1);
		expect(s.quickPick).toBe(quickPick);
		s.enterTab(count);
		expect(s.getCurrentQuestion()).toBeUndefined();
	});
	it("starts on recommended without selecting and remembers each cursor", () => {
		const s = make({ recommended: 2 }, 3);
		expect(s.optionIndex).toBe(2);
		expect(s.isAnswered(s.questions[0])).toBe(false);
		s.dispatch({ kind: "down" });
		s.dispatch({ kind: "nextTab" });
		expect(s.optionIndex).toBe(2);
		s.dispatch({ kind: "up" });
		s.dispatch({ kind: "prevTab" });
		expect(s.optionIndex).toBe(3);
		s.dispatch({ kind: "nextTab" });
		expect(s.optionIndex).toBe(1);
	});
	it("cycles through Review in both directions, even quickPick", () => {
		const s = make();
		s.dispatch({ kind: "prevTab" });
		expect(s.currentTab).toBe(1);
		s.dispatch({ kind: "nextTab" });
		expect(s.currentTab).toBe(0);
	});
	it.each([true, false])("wraps option navigation with allowOther=%s", (allowOther) => {
		const s = make({ allowOther });
		expect(s.totalRows(s.questions[0])).toBe(allowOther ? 4 : 3);
		s.dispatch({ kind: "up" });
		expect(s.optionIndex).toBe(allowOther ? 3 : 2);
		expect(s.isOtherRow(s.questions[0], s.optionIndex)).toBe(allowOther);
		s.dispatch({ kind: "down" });
		expect(s.optionIndex).toBe(0);
		expect(s.dirty).toBe(false);
	});
});

describe("selection and digits", () => {
	it("single confirm selects and advances, then last question reaches Review", () => {
		const s = make({}, 2);
		s.optionIndex = 1;
		expect(s.dispatch({ kind: "confirm" })).toBeUndefined();
		expect(s.getSingleAnswer("q1")).toBe(1);
		expect(s.currentTab).toBe(1);
		expect(s.isAnswered(s.questions[1])).toBe(false);
		s.dispatch({ kind: "confirm" });
		expect(s.currentTab).toBe(2);
		expect(s.isAnswered(s.questions[1])).toBe(true);
	});
	it("single digit selects the indexed option and quickPick finalizes", () => {
		const s = make();
		expect(s.dispatch({ kind: "digit", n: 2 })).toEqual(submit);
		expect(s.optionIndex).toBe(1);
		expect(s.buildAnswer(s.questions[0])).toEqual({ id: "q1", multi: false, wasCustom: false, values: ["b"], labels: ["b"], indices: [2] });
	});
	it.each([0, 4, 9, 10, 1.5])("ignores invalid or out-of-options digit %s", (n) => {
		const s = make();
		expect(s.dispatch({ kind: "digit", n })).toBeUndefined();
		expect(s.optionIndex).toBe(0);
		expect(s.dirty).toBe(false);
	});
	it("multi digits toggle without advancing, in option order", () => {
		const s = make({ multi: true });
		s.dispatch({ kind: "digit", n: 3 });
		s.dispatch({ kind: "digit", n: 1 });
		expect(s.currentTab).toBe(0);
		expect(s.buildAnswer(s.questions[0])).toMatchObject({ values: ["a", "c"], labels: ["Alpha", "c"], indices: [1, 3] });
		s.dispatch({ kind: "digit", n: 3 });
		s.dispatch({ kind: "digit", n: 1 });
		expect(s.buildAnswer(s.questions[0])).toBeUndefined();
	});
	it("multi confirm advances without toggling, and single toggle does nothing", () => {
		const m = make({ multi: true });
		m.dispatch({ kind: "confirm" });
		expect(m.currentTab).toBe(1);
		expect(m.isAnswered(m.questions[0])).toBe(false);
		const s = make();
		s.dispatch({ kind: "toggle" });
		expect(s.dirty).toBe(false);
	});
	it.each(["confirm", "digit"] as const)("quickPick %s with any saved note reaches Review instead", (kind) => {
		const s = make();
		s.dispatch({ kind: "noteOption" });
		s.submitEditor("why this?");
		expect(s.dispatch(kind === "digit" ? { kind, n: 1 } : { kind })).toBeUndefined();
		expect(s.currentTab).toBe(1);
	});
});

describe("custom editor and drafts", () => {
	it("opens Other with empty text and trims single submission, clearing a pick", () => {
		const s = make({}, 2);
		s.selectSingle();
		expect(openCustom(s)).toEqual({ kind: "openEditor", target: custom, initialText: "" });
		expect(s.editorTarget).toEqual(custom);
		s.submitEditor("  hello  ");
		expect(s.currentTab).toBe(1);
		expect(s.getSingleAnswer("q1")).toBeUndefined();
		expect(s.buildAnswer(s.questions[0])).toEqual({ id: "q1", multi: false, wasCustom: true, values: [], labels: [], indices: [], customInput: "hello" });
	});
	it("single custom quickPick submits unless there are notes", () => {
		const s = make();
		openCustom(s);
		expect(s.submitEditor("text")).toEqual(submit);
		const noted = make();
		saveNote(noted);
		openCustom(noted);
		expect(noted.submitEditor("text")).toBeUndefined();
		expect(noted.currentTab).toBe(1);
	});
	it("selecting a single option moves saved custom into a draft", () => {
		const s = make({}, 2);
		s.setCustom("q1", "saved");
		s.optionIndex = 1;
		s.dispatch({ kind: "confirm" });
		expect(s.getCustomInput("q1")).toBeUndefined();
		expect(s.getDraft(custom)).toBe("saved");
		s.enterTab(0);
		expect(openCustom(s)).toMatchObject({ initialText: "saved" });
	});
	it("multi custom keeps options, stays, and option toggle keeps custom", () => {
		const s = make({ multi: true });
		s.dispatch({ kind: "toggle" });
		openCustom(s);
		s.submitEditor(" custom ");
		expect(s.currentTab).toBe(0);
		s.dispatch({ kind: "digit", n: 3 });
		expect(s.buildAnswer(s.questions[0])).toMatchObject({ wasCustom: true, values: ["a", "c"], indices: [1, 3], customInput: "custom" });
	});
	it("multi Other toggle opens editor, deselects saved custom to draft, then restores it", () => {
		const s = make({ multi: true });
		s.optionIndex = 3;
		expect(s.dispatch({ kind: "toggle" })).toMatchObject({ kind: "openEditor" });
		s.submitEditor("text");
		s.dispatch({ kind: "toggle" });
		expect(s.getCustomInput("q1")).toBeUndefined();
		expect(s.getDraft(custom)).toBe("text");
		expect(s.isOptionToggled("q1", 3)).toBe(false);
		s.dispatch({ kind: "toggle" });
		expect(s.getCustomInput("q1")).toBe("text");
		expect(s.getDraft(custom)).toBeUndefined();
	});
	it("cancel keeps raw typed draft ahead of saved text; empty submit deletes both and stays", () => {
		const s = make({ multi: true });
		s.setCustom("q1", "saved");
		expect(openCustom(s)).toMatchObject({ initialText: "saved" });
		s.cancelEditor("  draft  ");
		expect(s.editorTarget).toBeUndefined();
		expect(s.getCustomInput("q1")).toBe("saved");
		expect(openCustom(s)).toMatchObject({ initialText: "  draft  " });
		s.submitEditor("  ");
		expect(s.getCustomInput("q1")).toBeUndefined();
		expect(s.getDraft(custom)).toBeUndefined();
		expect(s.currentTab).toBe(0);
		expect(s.dirty).toBe(false);
	});
	it("blank cancel keeps no draft, so multi Other toggle reopens the editor", () => {
		const s = make({ multi: true });
		s.optionIndex = 3;
		s.dispatch({ kind: "toggle" });
		s.cancelEditor("   ");
		expect(s.getDraft(custom)).toBeUndefined();
		expect(s.dirty).toBe(false);
		expect(s.dispatch({ kind: "toggle" })).toMatchObject({ kind: "openEditor", target: custom });
	});
	it("empty single custom stays and does not erase an existing option pick", () => {
		const s = make();
		s.selectSingle();
		openCustom(s);
		expect(s.submitEditor(" ")).toBeUndefined();
		expect(s.currentTab).toBe(0);
		expect(s.getSingleAnswer("q1")).toBe(0);
	});
});

describe("notes", () => {
	it("isolates note targets even when question ids contain target separators", () => {
		const s = new AskState(normalizeQuestions([question(), question({ id: "q1:0" })]));
		s.dispatch({ kind: "noteOption" });
		s.cancelEditor("option draft");
		s.enterTab(1);
		saveNote(s, "question note");
		expect(s.getDraft(optionNote)).toBe("option draft");
		expect(s.getNote("q1:0")).toBe("question note");
		expect(s.getNote("q1", 0)).toBeUndefined();
	});
	it("empty option-note submission deletes its saved note and draft", () => {
		const s = make();
		s.dispatch({ kind: "noteOption" });
		s.submitEditor("saved");
		s.dispatch({ kind: "noteOption" });
		s.cancelEditor("draft");
		s.dispatch({ kind: "noteOption" });
		s.submitEditor(" ");
		expect(s.getNote("q1", 0)).toBeUndefined();
		expect(s.getDraft(optionNote)).toBeUndefined();
		expect(s.elaborateEnabled).toBe(false);
	});
	it("n targets highlighted option; N and n on Other target the question", () => {
		const s = make();
		expect(s.dispatch({ kind: "noteOption" })).toEqual({ kind: "openEditor", target: optionNote, initialText: "" });
		s.submitEditor(" option note ");
		expect(s.getNote("q1", 0)).toBe("option note");
		expect(s.dispatch({ kind: "noteQuestion" })).toMatchObject({ target: note });
		s.submitEditor(" question note ");
		s.optionIndex = 3;
		expect(s.dispatch({ kind: "noteOption" })).toMatchObject({ target: note, initialText: "question note" });
		s.submitEditor("");
		expect(s.getNote("q1")).toBeUndefined();
		expect(s.currentTab).toBe(0);
	});
	it("keeps per-target drafts on cancel without changing saved notes; empty deletes note/draft", () => {
		const s = make();
		saveNote(s, "saved");
		s.dispatch({ kind: "noteQuestion" });
		s.cancelEditor("draft question");
		s.dispatch({ kind: "noteOption" });
		s.cancelEditor("draft option");
		openCustom(s);
		s.cancelEditor("draft custom");
		expect(s.getDraft(note)).toBe("draft question");
		expect(s.getDraft(optionNote)).toBe("draft option");
		expect(s.getDraft(custom)).toBe("draft custom");
		expect(s.getNote("q1")).toBe("saved");
		expect(s.dispatch({ kind: "noteQuestion" })).toMatchObject({ initialText: "draft question" });
		s.submitEditor("  ");
		expect(s.getNote("q1")).toBeUndefined();
		expect(s.getDraft(note)).toBeUndefined();
	});
	it("details include answered questions only and notes in question then option order", () => {
		const input = [question(), question({ id: "q2" })];
		const s = new AskState(normalizeQuestions(input));
		s.enterTab(1);
		saveNote(s, "second");
		s.enterTab(0);
		s.optionIndex = 2;
		s.dispatch({ kind: "noteOption" });
		s.submitEditor("third option");
		saveNote(s, "first question");
		s.optionIndex = 0;
		s.dispatch({ kind: "noteOption" });
		s.submitEditor("first option");
		s.selectSingle();
		const details = s.buildDetails(input, "Title", { mode: "elaborate" });
		expect(details.questions).toBe(input);
		expect(details).toMatchObject({ title: "Title", mode: "elaborate", cancelled: false });
		expect(details.answers.map((a) => a.id)).toEqual(["q1"]);
		expect(details.notes).toEqual([
			{ questionId: "q1", text: "first question" },
			{ questionId: "q1", optionValue: "a", text: "first option" },
			{ questionId: "q1", optionValue: "c", text: "third option" },
			{ questionId: "q2", text: "second" },
		]);
		expect(s.buildDetails(input, undefined, { cancelled: true })).toMatchObject({ mode: "submit", cancelled: true });
	});
});

describe("Review actions", () => {
	it("partial submit is allowed even for required questions", () => {
		const s = make({ required: true });
		s.enterTab(1);
		expect(s.reviewActionIndex).toBe(0);
		expect(s.dispatch({ kind: "confirm" })).toEqual(submit);
	});
	it("cursor wraps and confirm runs selected action; Cancel has no dirty guard", () => {
		const s = make({ multi: true });
		s.dispatch({ kind: "toggle" });
		s.enterTab(1);
		s.dispatch({ kind: "up" });
		expect(s.reviewActionIndex).toBe(2);
		s.dispatch({ kind: "down" });
		expect(s.reviewActionIndex).toBe(0);
		s.dispatch({ kind: "up" });
		expect(s.dispatch({ kind: "confirm" })).toEqual(cancel);
		expect(s.dismissPending).toBe(false);
	});
	it("Elaborate does nothing without saved notes (drafts do not enable it)", () => {
		const s = make();
		s.dispatch({ kind: "noteQuestion" });
		s.cancelEditor("draft");
		s.enterTab(1);
		expect(s.elaborateEnabled).toBe(false);
		expect(s.dispatch({ kind: "digit", n: 2 })).toBeUndefined();
		s.dispatch({ kind: "down" });
		expect(s.reviewActionIndex).toBe(1);
		expect(s.dispatch({ kind: "confirm" })).toBeUndefined();
		expect(s.dispatch({ kind: "digit", n: 1 })).toEqual(submit);
	});
	it.each(["confirm", "digit"] as const)("Elaborate via %s preserves decisions", (kind) => {
		const s = make();
		saveNote(s);
		s.selectSingle();
		s.enterTab(1);
		s.dispatch({ kind: "down" });
		expect(s.elaborateEnabled).toBe(true);
		expect(s.dispatch(kind === "digit" ? { kind, n: 2 } : { kind })).toEqual({ kind: "finalize", result: { mode: "elaborate" } });
		expect(s.getSingleAnswer("q1")).toBe(0);
	});
	it("Review digits directly submit/cancel, ignoring 4-9", () => {
		const s = make();
		s.enterTab(1);
		expect(s.dispatch({ kind: "digit", n: 4 })).toBeUndefined();
		expect(s.dispatch({ kind: "digit", n: 3 })).toEqual(cancel);
	});
});

describe("dismiss and finalize safety", () => {
	it("clean cancel is immediate after navigation too", () => {
		const s = make({}, 2);
		s.dispatch({ kind: "down" });
		s.dispatch({ kind: "nextTab" });
		expect(s.dispatch({ kind: "cancel" })).toEqual(cancel);
	});
	it.each(["answer", "custom", "note", "draft"])("guards dirty %s, then second cancel discards", (dirty) => {
		const s = make({ multi: true });
		if (dirty === "answer") s.dispatch({ kind: "toggle" });
		if (dirty === "custom") s.setCustom("q1", "saved");
		if (dirty === "note") saveNote(s);
		if (dirty === "draft") { openCustom(s); s.cancelEditor("typed"); }
		expect(s.dirty).toBe(true);
		expect(s.dispatch({ kind: "cancel" })).toBeUndefined();
		expect(s.dismissPending).toBe(true);
		expect(s.dispatch({ kind: "cancel" })).toEqual(cancel);
	});
	it.each([{ kind: "up" }, { kind: "digit", n: 9 }, undefined] satisfies (KeyEvent | undefined)[])("any other key clears pending (%j)", (key) => {
		const s = make({ multi: true });
		s.dispatch({ kind: "toggle" });
		s.dispatch({ kind: "cancel" });
		s.dispatch(key);
		expect(s.dismissPending).toBe(false);
		expect(s.dispatch({ kind: "cancel" })).toBeUndefined();
	});
	it("editor cancel is isolated, and state ignores normal dispatch while editing", () => {
		const s = make();
		openCustom(s);
		expect(s.dispatch({ kind: "cancel" })).toBeUndefined();
		expect(s.dismissPending).toBe(false);
		s.cancelEditor("typed");
		expect(s.getDraft(custom)).toBe("typed");
	});
	it("finalize fires once when abort races a key and blocks later editor submit", () => {
		const s = make();
		expect(s.dispatch({ kind: "confirm" })).toEqual(submit);
		expect(s.finalize({ cancelled: true })).toBeUndefined();
		expect(s.dispatch({ kind: "cancel" })).toBeUndefined();
		const abort = make();
		openCustom(abort);
		expect(abort.finalize({ cancelled: true })).toEqual(cancel);
		expect(abort.submitEditor("late")).toBeUndefined();
		expect(abort.getCustomInput("q1")).toBeUndefined();
	});
});
