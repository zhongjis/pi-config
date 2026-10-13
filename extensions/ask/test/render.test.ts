import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import ask from "../index.js";

vi.mock("@earendil-works/pi-tui", async () =>
	import("../../../node_modules/@earendil-works/pi-tui/dist/index.js")
);

type RenderableText = { render?: (width: number) => string[]; text?: string };
type PlainTheme = { fg: (color: string, text: string) => string; bold: (text: string) => string };
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
};

function renderText(component: RenderableText, width = 120): string {
	if (typeof component.render === "function") return component.render(width).join("\n");
	return component.text ?? "";
}

function expectWidthSafe(component: RenderableText): void {
	expect(component.render).toBeTypeOf("function");
	for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
		for (const line of component.render!(width)) {
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
		options: Object.freeze([Object.freeze({ value: "src", label: "Source" })]),
	}),
	Object.freeze({
		id: "risk",
		label: "Risk",
		prompt: "How much risk is acceptable?",
		allowOther: false,
		options: Object.freeze([Object.freeze({ value: "low", label: "Low" })]),
	}),
]);

describe("ask tool rendering", () => {
	it("prefixes title, retains first prompt and adds preview/required flags", () => {
		const tool = registerAskTool();
		const call = tool.renderCall!({ title: "Decisions", questions: [{ id: "q", prompt: "Compare", required: true, options: [{ value: "a", label: "A", preview: "code" }] }] }, plainTheme);
		expect(renderText(call)).toContain("Decisions · 1 question · other, preview, required · first: Compare");
		expectWidthSafe(call);
	});
	it("summarizes invalid and elaborate before cancelled or no-answer branches", () => {
		const tool = registerAskTool();
		const invalid = tool.renderResult!({ content: [{ type: "text", text: "Invalid ask payload" }], details: { cancelled: true, error: { issues: [{ path: "questions", message: "empty" }] } } }, {}, plainTheme);
		expect(renderText(invalid)).toContain("status: invalid payload · 1 issue");
		expectWidthSafe(invalid);
		const elaborate = tool.renderResult!({ content: [{ type: "text", text: "clarification" }], details: { mode: "elaborate", cancelled: false, answers: [], notes: [{ questionId: "q", text: "why?" }] } }, {}, plainTheme);
		expect(renderText(elaborate)).toContain("status: elaborate · 1 note");
		expectWidthSafe(elaborate);
	});
	it("summarizes answers from fields, including saved custom answers without indices", () => {
		const tool = registerAskTool();
		const legacy = tool.renderResult!({ content: [{ type: "text", text: "Scope: user wrote: hand-typed" }], details: { questions, cancelled: false, answers: [{ id: "scope", multi: true, wasCustom: true, values: [], labels: [], customInput: "hand-typed" }] } }, {}, plainTheme);
		expect(renderText(legacy)).toContain("answer: Scope · wrote: hand-typed");
		const mixed = tool.renderResult!({ content: [{ type: "text", text: "raw" }], details: { questions, cancelled: false, mode: "submit", notes: [], answers: [{ id: "scope", multi: true, wasCustom: true, values: ["src"], labels: ["Source"], indices: [1], customInput: "docs" }] } }, {}, plainTheme);
		expect(renderText(mixed)).toContain("answer: Scope · 1. src; wrote: docs");
		expectWidthSafe(mixed);
	});
	it("renders call count, flags, and first prompt only", () => {
		const tool = registerAskTool();
		const call = tool.renderCall!({ questions }, plainTheme);
		const text = renderText(call);

		expect(text).toContain("▸ ask · 2 questions · multi, recommended, other · first: Which scope should be reviewed?");
		expect(text).not.toContain("How much risk is acceptable?");
		expectWidthSafe(call);
	});

	it("summarizes answer, cancel, no-answer, and raw error while preserving expanded raw", () => {
		const tool = registerAskTool();
		const raw = "Scope: user selected: 1. Source\nRisk: user selected: 1. Low";
		const result = Object.freeze({
			content: Object.freeze([Object.freeze({ type: "text" as const, text: raw })]),
			details: Object.freeze({
				questions,
				cancelled: false,
				answers: Object.freeze([
					Object.freeze({ id: "scope", multi: true, wasCustom: false, values: Object.freeze(["src"]), labels: Object.freeze(["Source"]), indices: Object.freeze([1]) }),
				]),
			}),
		});

		const collapsed = tool.renderResult!(result, { expanded: false }, plainTheme, {});
		expect(renderText(collapsed)).toContain("status: answered · 1/2");
		expect(renderText(collapsed)).toContain("answer: Scope · 1. src");
		expect(tool.renderResult!(result, { expanded: true }, plainTheme, {}).text).toBe(raw);
		expect(result.content[0].text).toBe(raw);
		expectWidthSafe(collapsed);

		expect(renderText(tool.renderResult!({ content: [{ type: "text", text: "User cancelled the questions." }], details: { questions, answers: [], cancelled: true } }, { expanded: false }, plainTheme, {})))
			.toContain("answer: user cancelled");
		expect(renderText(tool.renderResult!({ content: [{ type: "text", text: "" }], details: { questions, answers: [], cancelled: false } }, { expanded: false }, plainTheme, {})))
			.toContain("status: no answer · 2 questions");
		expect(renderText(tool.renderResult!({ content: [{ type: "text", text: "Error: ask tool requires interactive mode" }] }, { expanded: false }, plainTheme, {})))
			.toContain("result: Error: ask tool requires interactive mode");
	});
});
