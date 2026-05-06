import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingQuestion, NormalizedQuestion } from "../types.js";
import { normalizeQuestions } from "../normalize.js";
import { AskState, type DispatchCallbacks, type KeyEvent } from "../state.js";

const opt = (value: string, label = value) => ({ value, label });

function buildQs(specs: IncomingQuestion[]): NormalizedQuestion[] {
	return normalizeQuestions(specs);
}

function makeCallbacks(): DispatchCallbacks & {
	openCalls: string[];
	finalizeCalls: boolean[];
} {
	const openCalls: string[] = [];
	const finalizeCalls: boolean[] = [];
	return {
		onOpenEditor: (id) => openCalls.push(id),
		onFinalize: (c) => finalizeCalls.push(c),
		openCalls,
		finalizeCalls,
	};
}

const single1 = (): NormalizedQuestion[] =>
	buildQs([
		{ id: "q1", prompt: "p", options: [opt("a"), opt("b"), opt("c")] },
	]);

const multi1 = (): NormalizedQuestion[] =>
	buildQs([
		{ id: "q1", prompt: "p", options: [opt("a"), opt("b"), opt("c")], multi: true },
	]);

const three = (extra?: Partial<IncomingQuestion>): NormalizedQuestion[] =>
	buildQs([
		{ id: "q1", prompt: "p", options: [opt("a"), opt("b")], ...extra },
		{ id: "q2", prompt: "p", options: [opt("c"), opt("d")] },
		{ id: "q3", prompt: "p", options: [opt("e"), opt("f")] },
	]);

// ── constructor / shape ────────────────────────────────────────────────────
describe("AskState constructor", () => {
	it("autoFinalize=true for 1q + !multi", () => {
		const s = new AskState(single1());
		expect(s.autoFinalize).toBe(true);
		expect(s.hasTabBar).toBe(false);
		expect(s.totalTabs).toBe(1);
	});

	it("autoFinalize=false for 1q + multi", () => {
		const s = new AskState(multi1());
		expect(s.autoFinalize).toBe(false);
		expect(s.hasTabBar).toBe(true);
		expect(s.totalTabs).toBe(2);
	});

	it("autoFinalize=false for 2+ qs", () => {
		const s = new AskState(three());
		expect(s.autoFinalize).toBe(false);
		expect(s.hasTabBar).toBe(true);
		expect(s.totalTabs).toBe(4);
	});

	it("defaults: currentTab=0, optionIndex from recommended (or 0), inputMode=false", () => {
		const s = new AskState(three());
		expect(s.currentTab).toBe(0);
		expect(s.optionIndex).toBe(0);
		expect(s.inputMode).toBe(false);
		expect(s.inputQuestionId).toBeNull();
	});
});

// ── enterTab + cursor restore ──────────────────────────────────────────────
describe("AskState.enterTab + cursor restore", () => {
	it("first visit uses recommended", () => {
		const s = new AskState(three({ recommended: 1 }));
		expect(s.optionIndex).toBe(1);
	});

	it("first visit falls back to 0 when no recommended", () => {
		const s = new AskState(three());
		expect(s.optionIndex).toBe(0);
	});

	it("revisit uses lastCursor", () => {
		const s = new AskState(three());
		s.optionIndex = 2; // user moved to row 2 (Other row included)
		s.rememberCursor();
		s.enterTab(1);
		expect(s.optionIndex).toBe(0); // q2 fresh
		s.enterTab(0);
		expect(s.optionIndex).toBe(2);
	});

	it("rememberCursor stashes BEFORE switch", () => {
		const s = new AskState(three());
		s.optionIndex = 1;
		s.rememberCursor();
		s.enterTab(2);
		s.enterTab(0);
		expect(s.optionIndex).toBe(1);
	});

	it("enterTab marks dirty", () => {
		const s = new AskState(three());
		s.dirty = false;
		s.enterTab(1);
		expect(s.dirty).toBe(true);
	});
});

// ── moveOption ─────────────────────────────────────────────────────────────
describe("AskState.moveOption", () => {
	it("up at 0 wraps to last", () => {
		const s = new AskState(three()); // 2 options + Other row → 3 rows
		s.optionIndex = 0;
		s.moveOption(-1);
		expect(s.optionIndex).toBe(2);
	});

	it("down at last wraps to 0", () => {
		const s = new AskState(three());
		s.optionIndex = 2;
		s.moveOption(1);
		expect(s.optionIndex).toBe(0);
	});

	it("normal +/-1 in range", () => {
		const s = new AskState(three());
		s.optionIndex = 1;
		s.moveOption(1);
		expect(s.optionIndex).toBe(2);
		s.moveOption(-1);
		expect(s.optionIndex).toBe(1);
	});

	it("totalRows includes Other row when allowOther", () => {
		const q = three()[0];
		const s = new AskState(three());
		expect(s.totalRows(q)).toBe(3);
	});

	it("totalRows excludes Other when allowOther=false", () => {
		const qs = buildQs([{ id: "q", prompt: "p", options: [opt("a"), opt("b")], allowOther: false }]);
		const s = new AskState(qs);
		expect(s.totalRows(qs[0])).toBe(2);
	});

	it("dirty after move", () => {
		const s = new AskState(three());
		s.dirty = false;
		s.moveOption(1);
		expect(s.dirty).toBe(true);
	});
});

describe("AskState.isOtherRow", () => {
	it("true at last index when allowOther=true", () => {
		const qs = three();
		const s = new AskState(qs);
		expect(s.isOtherRow(qs[0], 2)).toBe(true);
	});
	it("false when allowOther=false", () => {
		const qs = buildQs([{ id: "q", prompt: "p", options: [opt("a")], allowOther: false }]);
		const s = new AskState(qs);
		expect(s.isOtherRow(qs[0], 1)).toBe(false);
	});
});

// ── selectSingle ───────────────────────────────────────────────────────────
describe("AskState.selectSingle", () => {
	it("records single answer at current index", () => {
		const s = new AskState(three());
		s.optionIndex = 1;
		s.selectSingle();
		expect(s.getSingleAnswer("q1")).toBe(1);
	});

	it("clears prior customInput", () => {
		const s = new AskState(three());
		s.setCustom("q1", "free text");
		s.optionIndex = 0;
		s.selectSingle();
		expect(s.getCustomInput("q1")).toBeUndefined();
		expect(s.getSingleAnswer("q1")).toBe(0);
	});

	it("isAnswered after selectSingle", () => {
		const qs = three();
		const s = new AskState(qs);
		s.selectSingle();
		expect(s.isAnswered(qs[0])).toBe(true);
	});

	it("buildAnswer shape (single)", () => {
		const qs = three();
		const s = new AskState(qs);
		s.optionIndex = 1;
		s.selectSingle();
		const a = s.buildAnswer(qs[0]);
		expect(a).toEqual({
			id: "q1",
			multi: false,
			wasCustom: false,
			values: ["b"],
			labels: ["b"],
			indices: [2],
		});
	});
});

// ── toggleMulti ────────────────────────────────────────────────────────────
describe("AskState.toggleMulti", () => {
	it("adds and removes", () => {
		const qs = buildQs([{ id: "q", prompt: "p", options: [opt("a"), opt("b")], multi: true }]);
		const s = new AskState(qs);
		s.optionIndex = 0;
		s.toggleMulti();
		expect(s.isOptionToggled("q", 0)).toBe(true);
		s.toggleMulti();
		expect(s.isOptionToggled("q", 0)).toBe(false);
	});

	it("clears prior customInput", () => {
		const qs = buildQs([{ id: "q", prompt: "p", options: [opt("a")], multi: true }]);
		const s = new AskState(qs);
		s.setCustom("q", "x");
		s.optionIndex = 0;
		s.toggleMulti();
		expect(s.getCustomInput("q")).toBeUndefined();
		expect(s.isOptionToggled("q", 0)).toBe(true);
	});

	it("isAnswered when ≥1 toggled", () => {
		const qs = buildQs([{ id: "q", prompt: "p", options: [opt("a"), opt("b")], multi: true }]);
		const s = new AskState(qs);
		s.optionIndex = 1;
		s.toggleMulti();
		expect(s.isAnswered(qs[0])).toBe(true);
	});

	it("buildAnswer multi sorted (indices/values/labels)", () => {
		const qs = buildQs([
			{ id: "q", prompt: "p", options: [opt("a"), opt("b"), opt("c")], multi: true },
		]);
		const s = new AskState(qs);
		s.optionIndex = 2;
		s.toggleMulti();
		s.optionIndex = 0;
		s.toggleMulti();
		const a = s.buildAnswer(qs[0])!;
		expect(a.indices).toEqual([1, 3]);
		expect(a.values).toEqual(["a", "c"]);
		expect(a.labels).toEqual(["a", "c"]);
	});

	it("buildAnswer returns undefined when empty multi-set", () => {
		const qs = buildQs([{ id: "q", prompt: "p", options: [opt("a")], multi: true }]);
		const s = new AskState(qs);
		expect(s.buildAnswer(qs[0])).toBeUndefined();
	});
});

// ── setCustom ──────────────────────────────────────────────────────────────
describe("AskState.setCustom", () => {
	it("clears single + multi for the question", () => {
		const qs = buildQs([{ id: "q", prompt: "p", options: [opt("a"), opt("b")], multi: true }]);
		const s = new AskState(qs);
		s.optionIndex = 0;
		s.toggleMulti();
		s.setCustom("q", "free");
		expect(s.isOptionToggled("q", 0)).toBe(false);
		expect(s.getCustomInput("q")).toBe("free");
	});

	it("setCustom on single also clears single answer", () => {
		const s = new AskState(three());
		s.optionIndex = 1;
		s.selectSingle();
		s.setCustom("q1", "free");
		expect(s.getSingleAnswer("q1")).toBeUndefined();
	});

	it("buildAnswer wasCustom shape", () => {
		const qs = three();
		const s = new AskState(qs);
		s.setCustom("q1", "hi");
		const a = s.buildAnswer(qs[0]);
		expect(a).toEqual({
			id: "q1",
			multi: false,
			wasCustom: true,
			values: [],
			labels: [],
			customInput: "hi",
		});
	});
});

// ── allAnswered + buildDetails ─────────────────────────────────────────────
describe("AskState.allAnswered + buildDetails", () => {
	it("false until all answered", () => {
		const qs = three();
		const s = new AskState(qs);
		expect(s.allAnswered()).toBe(false);
		// answer all 3
		s.selectSingle();
		s.enterTab(1);
		s.selectSingle();
		s.enterTab(2);
		s.selectSingle();
		expect(s.allAnswered()).toBe(true);
	});

	it("buildDetails returns shape with original input array", () => {
		const input: IncomingQuestion[] = [
			{ id: "q1", prompt: "p", options: [opt("a")] },
		];
		const qs = normalizeQuestions(input);
		const s = new AskState(qs);
		s.selectSingle();
		const d = s.buildDetails(input, false);
		expect(d.questions).toBe(input);
		expect(d.cancelled).toBe(false);
		expect(d.answers).toHaveLength(1);
	});
});

// ── advanceAfterAnswer ─────────────────────────────────────────────────────
describe("AskState.advanceAfterAnswer", () => {
	let cb: ReturnType<typeof makeCallbacks>;
	beforeEach(() => {
		cb = makeCallbacks();
	});

	it("q[0]/3 → q[1] no callbacks", () => {
		const s = new AskState(three());
		s.advanceAfterAnswer(cb);
		expect(s.currentTab).toBe(1);
		expect(cb.openCalls).toEqual([]);
		expect(cb.finalizeCalls).toEqual([]);
	});

	it("q[2]/3 → Submit no callbacks", () => {
		const s = new AskState(three());
		s.enterTab(2);
		s.advanceAfterAnswer(cb);
		expect(s.currentTab).toBe(3); // Submit tab
		expect(cb.finalizeCalls).toEqual([]);
	});

	it("q[0]/1 + autoFinalize → onFinalize(false)", () => {
		const s = new AskState(single1());
		s.advanceAfterAnswer(cb);
		expect(cb.finalizeCalls).toEqual([false]);
	});

	it("q[0]/1 + multi → Submit", () => {
		const s = new AskState(multi1());
		s.advanceAfterAnswer(cb);
		expect(s.currentTab).toBe(1); // Submit tab
		expect(cb.finalizeCalls).toEqual([]);
	});
});

// ── dispatch escape ────────────────────────────────────────────────────────
describe("AskState.dispatch — escape", () => {
	it("escape → onFinalize(true)", () => {
		const cb = makeCallbacks();
		const s = new AskState(three());
		s.dispatch({ kind: "escape" }, cb);
		expect(cb.finalizeCalls).toEqual([true]);
	});
});

// ── dispatch on Submit tab ─────────────────────────────────────────────────
describe("AskState.dispatch — Submit tab", () => {
	function setupSubmit(): { s: AskState; cb: ReturnType<typeof makeCallbacks> } {
		const s = new AskState(three());
		s.enterTab(3); // Submit
		return { s, cb: makeCallbacks() };
	}

	it("tab → currentTab=0", () => {
		const { s, cb } = setupSubmit();
		s.dispatch({ kind: "tab" }, cb);
		expect(s.currentTab).toBe(0);
	});

	it("right → currentTab=0", () => {
		const { s, cb } = setupSubmit();
		s.dispatch({ kind: "right" }, cb);
		expect(s.currentTab).toBe(0);
	});

	it("shiftTab → currentTab=questions.length-1", () => {
		const { s, cb } = setupSubmit();
		s.dispatch({ kind: "shiftTab" }, cb);
		expect(s.currentTab).toBe(2);
	});

	it("left → currentTab=questions.length-1", () => {
		const { s, cb } = setupSubmit();
		s.dispatch({ kind: "left" }, cb);
		expect(s.currentTab).toBe(2);
	});

	it("enter+allAnswered → onFinalize(false)", () => {
		const { s, cb } = setupSubmit();
		// answer all 3
		s.enterTab(0); s.selectSingle();
		s.enterTab(1); s.selectSingle();
		s.enterTab(2); s.selectSingle();
		s.enterTab(3);
		s.dispatch({ kind: "enter" }, cb);
		expect(cb.finalizeCalls).toEqual([false]);
	});

	it("enter + !allAnswered → noop", () => {
		const { s, cb } = setupSubmit();
		s.dispatch({ kind: "enter" }, cb);
		expect(cb.finalizeCalls).toEqual([]);
	});
});

// ── dispatch on question tab — single ──────────────────────────────────────
describe("AskState.dispatch — question tab (single)", () => {
	let s: AskState;
	let cb: ReturnType<typeof makeCallbacks>;
	beforeEach(() => {
		s = new AskState(three());
		cb = makeCallbacks();
	});

	it("up moves cursor", () => {
		s.optionIndex = 1;
		s.dispatch({ kind: "up" }, cb);
		expect(s.optionIndex).toBe(0);
	});

	it("down moves cursor", () => {
		s.optionIndex = 0;
		s.dispatch({ kind: "down" }, cb);
		expect(s.optionIndex).toBe(1);
	});

	it("enter on regular row selects + advances", () => {
		s.optionIndex = 1;
		s.dispatch({ kind: "enter" }, cb);
		expect(s.getSingleAnswer("q1")).toBe(1);
		expect(s.currentTab).toBe(1);
	});

	it("enter on Other row → onOpenEditor (no select)", () => {
		s.optionIndex = 2; // Other row
		s.dispatch({ kind: "enter" }, cb);
		expect(cb.openCalls).toEqual(["q1"]);
		expect(s.getSingleAnswer("q1")).toBeUndefined();
		expect(s.currentTab).toBe(0);
	});

	it("space → noop", () => {
		s.optionIndex = 0;
		const before = s.getSingleAnswer("q1");
		s.dispatch({ kind: "space" }, cb);
		expect(s.getSingleAnswer("q1")).toBe(before);
	});

	it("tab/right wraps from q[2] back to q[0] via Submit", () => {
		s.enterTab(2);
		s.dispatch({ kind: "tab" }, cb);
		expect(s.currentTab).toBe(3); // Submit
		s.dispatch({ kind: "tab" }, cb);
		expect(s.currentTab).toBe(0);
	});
});

// ── dispatch on question tab — multi ───────────────────────────────────────
describe("AskState.dispatch — question tab (multi)", () => {
	const buildMulti = () =>
		buildQs([
			{ id: "q1", prompt: "p", options: [opt("a"), opt("b")], multi: true },
			{ id: "q2", prompt: "p", options: [opt("c"), opt("d")], multi: true },
		]);

	it("space on regular row toggles", () => {
		const s = new AskState(buildMulti());
		const cb = makeCallbacks();
		s.optionIndex = 0;
		s.dispatch({ kind: "space" }, cb);
		expect(s.isOptionToggled("q1", 0)).toBe(true);
	});

	it("space on Other row → noop", () => {
		const s = new AskState(buildMulti());
		const cb = makeCallbacks();
		s.optionIndex = 2; // Other
		s.dispatch({ kind: "space" }, cb);
		expect(s.isOptionToggled("q1", 2)).toBe(false);
	});

	it("enter on regular row → advance NO toggle", () => {
		const s = new AskState(buildMulti());
		const cb = makeCallbacks();
		s.optionIndex = 0;
		s.dispatch({ kind: "enter" }, cb);
		expect(s.isOptionToggled("q1", 0)).toBe(false);
		expect(s.currentTab).toBe(1);
	});

	it("enter on Other row → onOpenEditor", () => {
		const s = new AskState(buildMulti());
		const cb = makeCallbacks();
		s.optionIndex = 2; // Other
		s.dispatch({ kind: "enter" }, cb);
		expect(cb.openCalls).toEqual(["q1"]);
		expect(s.currentTab).toBe(0);
	});

	it("tab/right wraps", () => {
		const s = new AskState(buildMulti());
		const cb = makeCallbacks();
		s.enterTab(1);
		s.dispatch({ kind: "tab" }, cb);
		expect(s.currentTab).toBe(2); // Submit
		s.dispatch({ kind: "tab" }, cb);
		expect(s.currentTab).toBe(0);
	});
});

// ── mutual exclusion ───────────────────────────────────────────────────────
describe("AskState — mutual exclusion", () => {
	it("setCustom → clears multi", () => {
		const qs = buildQs([{ id: "q", prompt: "p", options: [opt("a"), opt("b")], multi: true }]);
		const s = new AskState(qs);
		s.optionIndex = 0;
		s.toggleMulti();
		s.setCustom("q", "x");
		expect(s.isOptionToggled("q", 0)).toBe(false);
	});

	it("toggleMulti → clears customInput", () => {
		const qs = buildQs([{ id: "q", prompt: "p", options: [opt("a")], multi: true }]);
		const s = new AskState(qs);
		s.setCustom("q", "x");
		s.optionIndex = 0;
		s.toggleMulti();
		expect(s.getCustomInput("q")).toBeUndefined();
	});

	it("selectSingle → clears customInput", () => {
		const s = new AskState(three());
		s.setCustom("q1", "x");
		s.optionIndex = 0;
		s.selectSingle();
		expect(s.getCustomInput("q1")).toBeUndefined();
	});

	it("setCustom → clears single", () => {
		const s = new AskState(three());
		s.optionIndex = 1;
		s.selectSingle();
		s.setCustom("q1", "x");
		expect(s.getSingleAnswer("q1")).toBeUndefined();
	});
});
