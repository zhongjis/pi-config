import { describe, expect, it } from "vitest";
import { AskParams, OptionSchema, QuestionSchema, type IncomingQuestion } from "../types.js";
import { buildInvalidDetails, normalizeQuestions, truncateTabLabel, validateInput } from "../normalize.js";

const opt = (value: string, label = value) => ({ value, label });

describe("validateInput", () => {
	it("invalid details preserve original input and every issue without answers or notes", () => {
		const input: IncomingQuestion[] = [{ id: "q", prompt: "", options: [] }];
		const result = validateInput(input);
		if (result.ok === false) {
			const details = buildInvalidDetails(input, "Decisions", result.issues);
			expect(details.questions).toBe(input);
			expect(details.error?.issues).toBe(result.issues);
			expect(details).toMatchObject({ title: "Decisions", answers: [], notes: [], cancelled: true, mode: "submit" });
		}
		expect(result.ok).toBe(false);
	});
	it.each([[], null, undefined, {}, "questions"])("rejects non-array or empty input %j", (input) => {
		expect(validateInput(input)).toEqual({ ok: false, issues: [{ path: "questions", message: "Must be a non-empty array" }] });
	});
	it("collects all issues with precise paths across questions and options", () => {
		const r = validateInput([
			{ id: "q", prompt: " ", options: [opt("a"), opt("a", " "), opt(" ")], recommended: 3 },
			{ id: "q", prompt: "p", options: [], recommended: -1 },
			{ id: " ", prompt: "", options: [opt("b", "")] },
		]);
		expect(r.ok).toBe(false);
		if (r.ok === false) {
			expect(r.issues.map((issue) => issue.path)).toEqual([
				"questions[0].prompt", "questions[0].options[1].value", "questions[0].options[1].label",
				"questions[0].options[2].value", "questions[0].options[2].label", "questions[0].recommended",
				"questions[1].id", "questions[1].options", "questions[1].recommended",
				"questions[2].id", "questions[2].prompt", "questions[2].options[0].label",
			]);
			expect(r.issues.every((issue) => issue.message.length > 0)).toBe(true);
		}
	});
	it("rejects missing fields without throwing", () => {
		const r = validateInput([{ id: "q", prompt: "p" }, null, { options: [null] }]);
		expect(r.ok).toBe(false);
		if (r.ok === false) expect(r.issues.map((i) => i.path)).toContain("questions[2].options[0].value");
	});
	it.each([-1, 1.5, 1, NaN, Infinity])("rejects invalid recommended %s", (recommended) => {
		const r = validateInput([{ id: "q", prompt: "p", options: [opt("a")], recommended }]);
		expect(r.ok).toBe(false);
		if (r.ok === false) expect(r.issues).toHaveLength(1);
	});
	it("accepts trimmed-nonblank strings, repeated values in different questions and valid recommendation", () => {
		expect(validateInput([
			{ id: " q1 ", prompt: " p ", options: [opt(" a ")], recommended: 0 },
			{ id: "q2", prompt: "p", options: [opt(" a ")] },
		])).toEqual({ ok: true });
	});
});

describe("truncateTabLabel", () => {
	it.each(["", "hello", "123456789012"])("returns short label %j unchanged", (label) => {
		expect(truncateTabLabel(label)).toBe(label);
	});

	it("truncates at 13 chars to first 12 + …", () => {
		expect(truncateTabLabel("1234567890123")).toBe("123456789012…");
	});

});

describe("normalizeQuestions", () => {
	it("preserves preview and normalizes advisory required", () => {
		const preview = "code\nmore code";
		const out = normalizeQuestions([
			{ id: "a", prompt: "p", options: [{ ...opt("a"), preview }], required: true },
			{ id: "b", prompt: "p", options: [opt("b")] },
		]);
		expect(out[0].options[0].preview).toBe(preview);
		expect(out[0].required).toBe(true);
		expect(out[1].required).toBe(false);
	});
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


describe("schema", () => {
	it("exposes title, preview and advisory required as optional fields", () => {
		expect(AskParams.properties.title.type).toBe("string");
		expect(OptionSchema.properties.preview.type).toBe("string");
		expect(QuestionSchema.properties.required.type).toBe("boolean");
		expect(QuestionSchema.required).not.toContain("required");
		expect(AskParams.required).not.toContain("title");
	});
});
