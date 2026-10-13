import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import ask from "../index.js";

vi.mock("@earendil-works/pi-tui", async () =>
	import("../../../node_modules/@earendil-works/pi-tui/dist/index.js")
);

type RenderableText = { render?: (width: number) => string[]; text?: string };
type PlainTheme = { fg: (color: string, text: string) => string; bold: (text: string) => string; italic: (text: string) => string };
type ToolResult = { content?: readonly { type: "text"; text: string }[]; details?: unknown };
type ToolDefinition = {
	name: string;
	renderCall?: (args: Record<string, unknown>, theme: PlainTheme, context?: unknown) => RenderableText;
	renderResult?: (
		result: ToolResult,
		options: { expanded?: boolean; isPartial?: boolean },
		theme: PlainTheme,
		context?: { args?: Record<string, unknown>; isError?: boolean },
	) => RenderableText;
};

const plainTheme: PlainTheme = {
	fg: vi.fn((_color: string, text: string) => text),
	bold: vi.fn((text: string) => text),
	italic: vi.fn((text: string) => text),
};
/** Marks every colour role so tests can assert which token styles each segment. */
const tagTheme: PlainTheme = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
	bold: (text) => text,
	italic: (text) => `<i>${text}</i>`,
};

function lines(component: RenderableText, width = 120): string[] {
	expect(component.render).toBeTypeOf("function");
	return component.render!(width);
}

/** Rendered rows without Text's trailing width padding. */
function rows(component: RenderableText, width = 120): string[] {
	return lines(component, width).map((line) => line.trimEnd());
}

function expectWidthSafe(component: RenderableText): void {
	for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
		for (const line of lines(component, width)) {
			expect(visibleWidth(line), `${JSON.stringify(line)} at width ${width}`).toBeLessThanOrEqual(width);
		}
	}
}

function registerAskTool(): ToolDefinition {
	let registered: ToolDefinition | undefined;
	ask({
		registerTool(tool: ToolDefinition) {
			registered = tool;
		},
	} as never);
	expect(registered).toBeDefined();
	return registered!;
}

const questions = Object.freeze([
	Object.freeze({
		id: "scope",
		label: "Scope",
		prompt: "Which scope should be reviewed?",
		multi: true,
		recommended: 0,
		options: Object.freeze([Object.freeze({ value: "src", label: "Source" }), Object.freeze({ value: "docs", label: "Docs" })]),
	}),
	Object.freeze({
		id: "risk",
		label: "Risk",
		prompt: "How much risk is acceptable?",
		required: true,
		allowOther: false,
		options: Object.freeze([Object.freeze({ value: "low", label: "Low" })]),
	}),
	Object.freeze({ id: "extra", prompt: "Anything else?", options: Object.freeze([Object.freeze({ value: "no", label: "No" })]) }),
]);
const scopeAnswer = Object.freeze({ id: "scope", multi: true, wasCustom: true, values: ["src"], labels: ["Source"], indices: [1], customInput: "docs" });
const notes = Object.freeze([
	Object.freeze({ questionId: "scope", optionValue: "docs", text: "public API only" }),
	Object.freeze({ questionId: "risk", text: "why ask?" }),
]);
const answered = { title: "Decisions", questions, answers: [scopeAnswer], notes: [], cancelled: false, mode: "submit" };
const elaborate = { ...answered, notes, mode: "elaborate" };
const cancelled = { ...answered, answers: [], cancelled: true };
const aborted = { ...cancelled, aborted: true };
const submittedEmpty = { ...answered, answers: [] };
const legacy = { questions, cancelled: false, answers: [{ id: "scope", multi: true, wasCustom: true, values: [], labels: [], customInput: "hand-typed" }] };
const invalid = {
	questions: [],
	answers: [],
	notes: [],
	cancelled: true,
	mode: "submit",
	error: { issues: [{ path: "questions[0].id", message: "Must be unique across questions" }, { path: "questions[1].options", message: "Must contain at least one option" }] },
};
const wide = {
	...answered,
	questions: [{ ...questions[0], label: "範囲🎉" }],
	answers: [{ ...scopeAnswer, customInput: `/very/long/${"unbroken".repeat(20)}/path` }],
	notes: [{ questionId: "scope", text: "e\u0301 combining 漢字 note" }],
};

function result(details: unknown, text = "raw model text"): ToolResult {
	return { content: [{ type: "text", text }], details };
}

describe("ask tool rendering", () => {
	it("renders the call as one row: title or first prompt, then question count", () => {
		const tool = registerAskTool();
		const titled = tool.renderCall!({ title: "Decisions", questions }, plainTheme);
		expect(rows(titled)).toEqual(["▸ ask · Decisions · 3 questions"]);
		const untitled = tool.renderCall!({ questions }, plainTheme);
		expect(rows(untitled)).toEqual(["▸ ask · Which scope should be reviewed? · 3 questions"]);
		expect(rows(tool.renderCall!({ questions: [] }, plainTheme))).toEqual(["▸ ask · 0 questions"]);

		const long = tool.renderCall!({ title: `Decide ${"everything ".repeat(20)}\nnow`, questions: [questions[0]] }, plainTheme);
		const [row, ...rest] = rows(long, 78);
		expect(rest).toEqual([]);
		expect(row).toContain("…");
		expect(row).toMatch(/· 1 question$/);
		expectWidthSafe(titled);
		expectWidthSafe(long);
	});

	it("collapses an answered result to status, human answers and the expand hint", () => {
		const tool = registerAskTool();
		const collapsed = tool.renderResult!(result(answered), { expanded: false }, plainTheme);
		const [status, answers, hint, ...rest] = rows(collapsed);
		expect(status).toBe("├─ ✓ answered 1/3 · 1 required missing");
		expect(answers).toBe("├─ Scope Source, “docs”");
		expect(hint).toMatch(/^└─ .*all answers$/);
		expect(rest).toEqual([]);

		const [tagged, taggedAnswers] = rows(tool.renderResult!(result(answered), { expanded: false }, tagTheme), 1000);
		expect(tagged).toContain("<success>✓</success><muted> answered 1/3</muted>");
		expect(tagged).toContain("<warning>1 required missing</warning>");
		expect(taggedAnswers).toContain("<muted>Scope </muted><text>Source, “docs”</text>");
	});

	it("collapses elaborate to note count and the first note with its question label", () => {
		const tool = registerAskTool();
		const [status, note, hint, ...rest] = rows(tool.renderResult!(result(elaborate), { expanded: false }, plainTheme));
		expect(status).toBe("├─ ✎ elaborate · 2 notes · 1/3 answered");
		expect(note).toBe("├─ Scope ✎ Docs: public API only");
		expect(hint).toMatch(/^└─ .*answers and notes$/);
		expect(rest).toEqual([]);
		const [, tagged] = rows(tool.renderResult!(result(elaborate), { expanded: false }, tagTheme), 1000);
		expect(tagged).toContain("<muted>Scope </muted><muted><i>✎ Docs: public API only</i></muted>");
	});

	it("renders cancelled, aborted and empty submissions as single terminal rows", () => {
		const tool = registerAskTool();
		expect(rows(tool.renderResult!(result(cancelled), { expanded: false }, plainTheme))).toEqual(["└─ ✗ cancelled by user"]);
		expect(rows(tool.renderResult!(result(aborted), { expanded: false }, plainTheme))).toEqual(["└─ ✗ aborted before the user answered"]);
		expect(rows(tool.renderResult!(result(aborted), { expanded: true }, plainTheme))).toEqual(["✗ aborted before the user answered"]);
		expect(rows(tool.renderResult!(result(submittedEmpty), { expanded: false }, plainTheme))).toEqual(["└─ ✓ submitted · 0/3 answered · 1 required missing"]);
	});

	it("summarizes an invalid payload by its first issue and expands to the raw issue list", () => {
		const tool = registerAskTool();
		const raw = "Invalid ask payload:\n- questions[0].id: Must be unique across questions\n- questions[1].options: Must contain at least one option";
		const [status, issue, hint, ...rest] = rows(tool.renderResult!(result(invalid, raw), { expanded: false }, plainTheme));
		expect(status).toBe("├─ ✗ invalid payload · 2 issues");
		expect(issue).toBe("├─ questions[0].id: Must be unique across questions");
		expect(hint).toMatch(/^└─ .*all issues$/);
		expect(rest).toEqual([]);
		expect(rows(tool.renderResult!(result(invalid, raw), { expanded: false }, tagTheme), 1000)[0]).toContain("<error>✗</error>");
		expect(rows(tool.renderResult!(result(invalid, raw), { expanded: true }, plainTheme))).toEqual(raw.split("\n"));
	});

	it("expands to an aligned report of every answer and note from details, not the model text", () => {
		const tool = registerAskTool();
		const expanded = tool.renderResult!(result(elaborate, "Scope: user selected: 1. src"), { expanded: true }, plainTheme);
		expect(rows(expanded)).toEqual([
			"✎ elaborate · 2 notes · 1/3 answered",
			"",
			"Scope  Source, “docs”",
			"Risk   ! no answer · required",
			"Q3     — no answer",
			"",
			"Notes",
			"Scope  Docs: public API only",
			"Risk   why ask?",
		]);
		expect(rows(expanded, 20)).toEqual(expect.arrayContaining(["Scope", "  Source, “docs”", "Notes", "Risk", "  why ask?"]));
		const tagged = rows(tool.renderResult!(result(elaborate), { expanded: true }, tagTheme), 1000).join("\n");
		expect(tagged).toContain("<warning>! no answer · required</warning>");
		expect(tagged).toContain("<muted>— no answer</muted>");
		expect(tagged).toContain("<text>Source, “docs”</text>");
	});

	it("renders legacy details without indices, notes or mode", () => {
		const tool = registerAskTool();
		const [status, answer] = rows(tool.renderResult!(result(legacy), { expanded: false }, plainTheme));
		expect(status).toBe("├─ ✓ answered 1/3 · 1 required missing");
		expect(answer).toBe("├─ Scope “hand-typed”");
		const expanded = rows(tool.renderResult!(result(legacy), { expanded: true }, plainTheme));
		expect(expanded).toContain("Scope  “hand-typed”");
		expect(expanded).not.toContain("Notes");
	});

	it("falls back to raw text when details are missing or malformed", () => {
		const tool = registerAskTool();
		const raw = "Error: ask tool requires interactive mode";
		for (const details of [undefined, null, { answers: "nope", cancelled: false }, { cancelled: true, answers: [], error: {} }]) {
			const [row, hint] = rows(tool.renderResult!(result(details, raw), { expanded: false }, plainTheme));
			expect(row).toBe(`├─ result: ${raw}`);
			expect(hint).toMatch(/^└─ .*full result$/);
			expect(rows(tool.renderResult!(result(details, raw), { expanded: true }, plainTheme))).toEqual([raw]);
		}
		expect(rows(tool.renderResult!({ content: [] }, { expanded: false }, plainTheme))).toEqual(["└─ result: no answer details"]);
	});

	it("keeps collapsed results within three rows and every view width-safe", () => {
		const tool = registerAskTool();
		for (const details of [answered, elaborate, cancelled, aborted, submittedEmpty, legacy, invalid, wide, undefined]) {
			const collapsed = tool.renderResult!(result(details, "raw\nmodel text"), { expanded: false }, plainTheme);
			for (const width of [1, 2, 8, 20, 40, 80, 120]) expect(rows(collapsed, width).length).toBeLessThanOrEqual(3);
			expectWidthSafe(collapsed);
			expectWidthSafe(tool.renderResult!(result(details, "raw\nmodel text"), { expanded: true }, plainTheme));
		}
		expectWidthSafe(tool.renderCall!({ title: "範囲🎉 ".repeat(30), questions }, plainTheme));
	});
});
