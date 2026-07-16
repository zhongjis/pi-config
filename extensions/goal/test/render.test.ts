import { describe, expect, it, vi } from "vitest";
import { formatGoalToolResponse } from "../src/goal/format.js";
import type { Goal } from "../src/goal/types.js";
import piGoalExtension from "../src/index.js";

type RenderableText = { render?: () => string[]; text?: string };
type PlainTheme = { fg: (color: string, text: string) => string; bold: (text: string) => string };
type ToolDefinition = {
	name: string;
	renderCall?: (args: Record<string, unknown>, theme: PlainTheme) => RenderableText;
	renderResult?: (
		result: { content?: Array<{ type: "text"; text: string }>; isError?: boolean },
		options: { expanded?: boolean; isPartial?: boolean },
		theme: PlainTheme,
		context?: { isError?: boolean },
	) => RenderableText;
};

const plainTheme: PlainTheme = {
	fg: vi.fn((_color: string, text: string) => text),
	bold: vi.fn((text: string) => text),
};

function renderText(component: RenderableText): string {
	if (typeof component.render === "function") return component.render().join("\n");
	return component.text ?? "";
}

function registerTools(): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	piGoalExtension({
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		on() {},
		sendMessage() {},
	} as never);
	return tools;
}

function content(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

const activeGoal = {
	id: "g1",
	threadId: "t1",
	objective: "Ship the goal extension",
	status: "active",
	tokensUsed: 42_000,
	timeUsedSeconds: 125,
	createdAt: 1,
	updatedAt: 2,
	lastStartedAt: 2,
} as unknown as Goal;

const budgetGoal = { ...activeGoal, tokenBudget: 100_000 } as unknown as Goal;

const activeContent = formatGoalToolResponse(activeGoal, false);
const budgetContent = formatGoalToolResponse(budgetGoal, false);
const noGoalContent = formatGoalToolResponse(null, false);

describe("goal tool rendering", () => {
	it("renderCall shows the full tool name and objective for create_goal", () => {
		const tool = registerTools().get("create_goal");
		const text = renderText(tool!.renderCall!({ objective: "Ship the goal extension" }, plainTheme));
		expect(text).toContain("create_goal");
		expect(text).toContain("Ship the goal extension");
	});

	it("renderCall shows the status arg for update_goal and bare name for get_goal", () => {
		const tools = registerTools();
		expect(renderText(tools.get("update_goal")!.renderCall!({ status: "complete" }, plainTheme))).toContain("complete");
		expect(renderText(tools.get("get_goal")!.renderCall!({}, plainTheme))).toContain("get_goal");
	});

	it("collapses an active goal to scan-friendly keyword lines without repeating the title", () => {
		const tool = registerTools().get("get_goal");
		const text = renderText(tool!.renderResult!(content(activeContent), {}, plainTheme));
		expect(text).toContain("goal: Ship the goal extension");
		expect(text).toContain("status: active");
		expect(text).toContain("2m");
		expect(text).toContain("42K tokens");
		expect(text).toContain("to expand full result");
		expect(text).not.toContain("▸"); // renderResult must not repeat the call header
	});

	it("shows token budget when present", () => {
		const tool = registerTools().get("get_goal");
		const text = renderText(tool!.renderResult!(content(budgetContent), {}, plainTheme));
		expect(text).toContain("42K/100K tokens");
	});

	it("expanded result equals the raw content exactly", () => {
		const tool = registerTools().get("get_goal");
		const text = renderText(tool!.renderResult!(content(activeContent), { expanded: true }, plainTheme));
		expect(text).toBe(activeContent);
	});

	it("shows a clear line when no goal is set", () => {
		const tool = registerTools().get("get_goal");
		const text = renderText(tool!.renderResult!(content(noGoalContent), {}, plainTheme));
		expect(text).toContain("goal: none set");
		expect(text).toContain("to expand full result");
	});

	it("surfaces the first decisive error line for error results", () => {
		const tool = registerTools().get("create_goal");
		const raw = "cannot create a new goal because this thread already has a goal; use update_goal only when the existing goal is complete";
		const text = renderText(tool!.renderResult!({ ...content(raw), isError: true }, {}, plainTheme));
		expect(text).toContain("error: cannot create a new goal");
		expect(text).toContain("to expand full result");
	});

	it("shows running for partial results", () => {
		const tool = registerTools().get("update_goal");
		const text = renderText(tool!.renderResult!(content(""), { isPartial: true }, plainTheme));
		expect(text).toContain("status: running");
	});

	it("truncates a very long objective", () => {
		const tool = registerTools().get("get_goal");
		const longGoal = { ...activeGoal, objective: "x".repeat(200) } as unknown as Goal;
		const text = renderText(tool!.renderResult!(content(formatGoalToolResponse(longGoal, false)), {}, plainTheme));
		expect(text).toContain("…");
		expect(text).not.toContain("x".repeat(200));
	});
});
