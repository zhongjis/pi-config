import { describe, expect, it } from "vitest";
import type { IncomingQuestion } from "../types.js";
import { normalizeQuestions, truncateTabLabel, validateInput } from "../normalize.js";

const opt = (value: string, label = value) => ({ value, label });

describe("validateInput", () => {
	it("rejects empty array", () => {
		const r = validateInput([]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe("Error: at least one question must be provided");
	});

	it("rejects question with empty options array, includes id", () => {
		const r = validateInput([{ id: "qX", prompt: "p", options: [] }]);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toContain("'qX'");
			expect(r.error).toContain("no options");
		}
	});

	it("rejects question with missing options field", () => {
		const r = validateInput([{ id: "qY", prompt: "p" } as unknown as IncomingQuestion]);
		expect(r.ok).toBe(false);
	});

	it("accepts a valid input", () => {
		const r = validateInput([{ id: "q1", prompt: "p", options: [opt("a")] }]);
		expect(r.ok).toBe(true);
	});
});

describe("truncateTabLabel", () => {
	it("returns unchanged when ≤ 12 chars", () => {
		expect(truncateTabLabel("hello")).toBe("hello");
	});

	it("returns unchanged at exactly 12 chars", () => {
		expect(truncateTabLabel("123456789012")).toBe("123456789012");
	});

	it("truncates at 13 chars to first 12 + …", () => {
		expect(truncateTabLabel("1234567890123")).toBe("123456789012…");
	});

	it("returns empty unchanged", () => {
		expect(truncateTabLabel("")).toBe("");
	});
});

describe("normalizeQuestions", () => {
	it("defaults rawLabel to Q1, Q2, …", () => {
		const out = normalizeQuestions([
			{ id: "a", prompt: "p", options: [opt("x")] },
			{ id: "b", prompt: "p", options: [opt("x")] },
		]);
		expect(out[0].rawLabel).toBe("Q1");
		expect(out[1].rawLabel).toBe("Q2");
	});

	it("preserves custom label and applies truncation in tabLabel", () => {
		const out = normalizeQuestions([
			{ id: "a", label: "PriorityLevels", prompt: "p", options: [opt("x")] },
		]);
		expect(out[0].rawLabel).toBe("PriorityLevels");
		expect(out[0].tabLabel).toBe("PriorityLeve…");
	});

	it("allowOther defaults to true; explicit false preserved", () => {
		const out = normalizeQuestions([
			{ id: "a", prompt: "p", options: [opt("x")] },
			{ id: "b", prompt: "p", options: [opt("x")], allowOther: false },
		]);
		expect(out[0].allowOther).toBe(true);
		expect(out[1].allowOther).toBe(false);
	});

	it("multi defaults to false; explicit true preserved", () => {
		const out = normalizeQuestions([
			{ id: "a", prompt: "p", options: [opt("x")] },
			{ id: "b", prompt: "p", options: [opt("x")], multi: true },
		]);
		expect(out[0].multi).toBe(false);
		expect(out[1].multi).toBe(true);
	});

	it("recommended kept for valid integers (0, mid, last)", () => {
		const out = normalizeQuestions([
			{ id: "a", prompt: "p", options: [opt("x"), opt("y"), opt("z")], recommended: 0 },
			{ id: "b", prompt: "p", options: [opt("x"), opt("y"), opt("z")], recommended: 1 },
			{ id: "c", prompt: "p", options: [opt("x"), opt("y"), opt("z")], recommended: 2 },
		]);
		expect(out[0].recommended).toBe(0);
		expect(out[1].recommended).toBe(1);
		expect(out[2].recommended).toBe(2);
	});

	it("recommended dropped when negative, fractional, ≥ length, or undefined", () => {
		const out = normalizeQuestions([
			{ id: "neg", prompt: "p", options: [opt("x")], recommended: -1 },
			{ id: "frac", prompt: "p", options: [opt("x"), opt("y")], recommended: 0.5 },
			{ id: "oob", prompt: "p", options: [opt("x"), opt("y")], recommended: 2 },
			{ id: "u", prompt: "p", options: [opt("x")] },
		]);
		expect(out[0].recommended).toBeUndefined();
		expect(out[1].recommended).toBeUndefined();
		expect(out[2].recommended).toBeUndefined();
		expect(out[3].recommended).toBeUndefined();
	});
});
