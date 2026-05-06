import { describe, expect, it } from "vitest";
import type { Answer, NormalizedQuestion } from "../types.js";
import { displayValue, formatAnswerLine, helpText } from "../format.js";

const q: NormalizedQuestion = {
	id: "q1",
	rawLabel: "Q1",
	tabLabel: "Q1",
	prompt: "p",
	options: [
		{ value: "a", label: "Alpha" },
		{ value: "same", label: "same" },
		{ value: "c", label: "Charlie" },
	],
	allowOther: true,
	multi: false,
};

describe("displayValue", () => {
	it("returns value when value !== label", () => {
		expect(displayValue("a", "Alpha")).toBe("a");
	});
	it("returns label when value === label", () => {
		expect(displayValue("same", "same")).toBe("same");
	});
});

describe("formatAnswerLine", () => {
	it("returns (unanswered) when answer is undefined", () => {
		expect(formatAnswerLine(q, undefined)).toBe("Q1: (unanswered)");
	});

	it("returns 'user wrote:' for custom answer", () => {
		const a: Answer = { id: "q1", multi: false, wasCustom: true, values: [], labels: [], customInput: "hello" };
		expect(formatAnswerLine(q, a)).toBe("Q1: user wrote: hello");
	});

	it("returns (unanswered) when indices empty", () => {
		const a: Answer = { id: "q1", multi: false, wasCustom: false, values: [], labels: [], indices: [] };
		expect(formatAnswerLine(q, a)).toBe("Q1: (unanswered)");
	});

	it("single select where value !== label uses value", () => {
		const a: Answer = {
			id: "q1",
			multi: false,
			wasCustom: false,
			values: ["a"],
			labels: ["Alpha"],
			indices: [1],
		};
		expect(formatAnswerLine(q, a)).toBe("Q1: user selected: 1. a");
	});

	it("single select where value === label uses label", () => {
		const a: Answer = {
			id: "q1",
			multi: false,
			wasCustom: false,
			values: ["same"],
			labels: ["same"],
			indices: [2],
		};
		expect(formatAnswerLine(q, a)).toBe("Q1: user selected: 2. same");
	});

	it("multi joins indices with ', '", () => {
		const a: Answer = {
			id: "q1",
			multi: true,
			wasCustom: false,
			values: ["a", "c"],
			labels: ["Alpha", "Charlie"],
			indices: [1, 3],
		};
		expect(formatAnswerLine(q, a)).toBe("Q1: user selected: 1. a, 3. c");
	});

	it("multi mixes value/label per item correctly", () => {
		const a: Answer = {
			id: "q1",
			multi: true,
			wasCustom: false,
			values: ["a", "same"],
			labels: ["Alpha", "same"],
			indices: [1, 2],
		};
		expect(formatAnswerLine(q, a)).toBe("Q1: user selected: 1. a, 2. same");
	});
});

describe("helpText", () => {
	it("input mode", () => {
		expect(helpText({ mode: "input", multi: false, hasTabBar: false })).toBe(
			" Enter submit • Esc cancel input",
		);
	});

	it("submit mode", () => {
		expect(helpText({ mode: "submit", multi: false, hasTabBar: true })).toBe(
			" Tab/←→ back • Enter submit • Esc cancel",
		);
	});

	it("question + multi (with tab bar)", () => {
		expect(helpText({ mode: "question", multi: true, hasTabBar: true })).toBe(
			" ↑↓ navigate • Space toggle • Enter advance • Tab/←→ tabs • Esc cancel",
		);
	});

	it("question + !multi (with tab bar)", () => {
		expect(helpText({ mode: "question", multi: false, hasTabBar: true })).toBe(
			" ↑↓ navigate • Enter select • Tab/←→ tabs • Esc cancel",
		);
	});

	it("question + !multi (no tab bar)", () => {
		expect(helpText({ mode: "question", multi: false, hasTabBar: false })).toBe(
			" ↑↓ navigate • Enter select • Esc cancel",
		);
	});

	it("question + multi (no tab bar)", () => {
		expect(helpText({ mode: "question", multi: true, hasTabBar: false })).toBe(
			" ↑↓ navigate • Space toggle • Enter advance • Esc cancel",
		);
	});
});
