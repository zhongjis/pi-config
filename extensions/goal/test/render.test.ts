import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { formatGoalToolResponse } from "../src/goal/format.js";
import type { Goal } from "../src/goal/types.js";
import piGoalExtension from "../src/index.js";

type RenderableText = { render?: (width: number) => string[]; text?: string };
type PlainTheme = { fg: (color: string, text: string) => string; bold: (text: string) => string };
type ToolDefinition = {
	name: string;
	renderCall?: (args: Record<string, unknown>, theme: PlainTheme) => RenderableText;
	renderResult?: (
		result: {
			content?: Array<{ type: "text"; text: string }>;
			details?: Record<string, unknown>;
			isError?: boolean;
		},
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
	if (typeof component.render !== "function") return;
	for (const width of [20, 40, 80, 120]) {
		for (const line of component.render(width)) {
			expect(visibleWidth(line), `${JSON.stringify(line)} at width ${width}`).toBeLessThanOrEqual(width);
		}
	}
}

function expectCollapsedRowBudget(component: RenderableText): void {
	const rows = (component.text ?? "").split(/\r\n?|\n/).length;
	expect(rows).toBeLessThanOrEqual(3);
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
	it("registers exactly three goal tools with call and result renderers", () => {
		const tools = registerTools();
		expect([...tools.keys()].sort()).toEqual(["create_goal", "get_goal", "update_goal"]);
		for (const tool of tools.values()) {
			expect(tool.renderCall).toBeTypeOf("function");
			expect(tool.renderResult).toBeTypeOf("function");
		}
	});

	it("renders calls with full names and decisive arguments", () => {
		const tools = registerTools();
		expect(tools.get("create_goal")!.renderCall!({ objective: "Ship the goal extension" }, plainTheme).text)
			.toBe('▸ create_goal · "Ship the goal extension"');
		expect(tools.get("update_goal")!.renderCall!({ status: "complete" }, plainTheme).text)
			.toBe("▸ update_goal · complete");
		expect(tools.get("get_goal")!.renderCall!({}, plainTheme).text).toBe("▸ get_goal");
	});

	it("shows objective, status, elapsed time, and available token usage", () => {
		const tool = registerTools().get("get_goal")!;
		const text = renderText(tool.renderResult!(content(activeContent), {}, plainTheme));
		expect(text).toContain("objective: Ship the goal extension");
		expect(text).toContain("status: active");
		expect(text).toContain("elapsed 2m");
		expect(text).toContain("tokens 42K");
		expect(text).toContain("app.tools.expand to expand full result");
		expect(text).not.toContain("▸");
	});

	it("shows token budget when present", () => {
		const tool = registerTools().get("get_goal")!;
		const text = renderText(tool.renderResult!(content(budgetContent), {}, plainTheme));
		expect(text).toContain("budget 42K/100K tokens");
	});

	it("omits zero and unavailable telemetry", () => {
		const tool = registerTools().get("get_goal")!;
		const quietGoal = { ...activeGoal, tokensUsed: 0, timeUsedSeconds: 0 } as unknown as Goal;
		const text = renderText(tool.renderResult!(content(formatGoalToolResponse(quietGoal, false)), {}, plainTheme));
		expect(text).toContain("objective: Ship the goal extension");
		expect(text).toContain("status: active");
		expect(text).not.toContain("elapsed");
		expect(text).not.toContain("tokens");
		expect(text).not.toContain("budget");
	});

	it("keeps expanded result equal to raw model-visible content", () => {
		const tool = registerTools().get("get_goal")!;
		const expanded = tool.renderResult!(content(activeContent), { expanded: true }, plainTheme);
		expect(expanded.text).toBe(activeContent);
	});

	it("handles no-goal, partial, malformed, and error states", () => {
		const tools = registerTools();
		const noGoal = renderText(tools.get("get_goal")!.renderResult!(content(noGoalContent), {}, plainTheme));
		expect(noGoal).toContain("goal: none set");
		expect(noGoal).toContain("app.tools.expand to expand full result");

		const partial = renderText(
			tools.get("update_goal")!.renderResult!(content(""), { isPartial: true }, plainTheme),
		);
		expect(partial).toContain("status: running");
		expect(partial).not.toContain("app.tools.expand");

		const malformed = renderText(
			tools.get("get_goal")!.renderResult!(content("legacy goal output"), {}, plainTheme),
		);
		expect(malformed).toContain("goal: legacy goal output");

		const rawError = "cannot create a new goal because this thread already has a goal; use update_goal only when the existing goal is complete\nstack hidden";
		const error = renderText(
			tools.get("create_goal")!.renderResult!({ ...content(rawError), isError: true }, {}, plainTheme),
		);
		expect(error).toContain("error: cannot create a new goal");
		expect(error).toContain("app.tools.expand to expand full result");
	});

	it("truncates a long objective only in collapsed presentation", () => {
		const tool = registerTools().get("get_goal")!;
		const objective = "完成目标".repeat(50);
		const raw = formatGoalToolResponse({ ...activeGoal, objective } as Goal, false);
		const summary = renderText(tool.renderResult!(content(raw), {}, plainTheme));
		const expanded = tool.renderResult!(content(raw), { expanded: true }, plainTheme);
		expect(summary).toContain("…");
		expect(summary).not.toContain(objective);
		expect(expanded.text).toBe(raw);
	});

	it("keeps frozen inputs unchanged, complete, width-safe, and within three logical rows", () => {
		const tools = registerTools();
		const args: Record<string, unknown> = { objective: "完成 Unicode 目标", token_budget: 100_000 };
		const details: Record<string, unknown> = { marker: "unchanged" };
		const raw = formatGoalToolResponse({ ...budgetGoal, objective: "完成 Unicode 目标" } as Goal, false);
		const result = { content: [{ type: "text" as const, text: raw }], details };
		Object.freeze(args);
		Object.freeze(details);
		Object.freeze(result.content[0]);
		Object.freeze(result.content);
		Object.freeze(result);

		for (const tool of tools.values()) {
			const call = tool.renderCall!(args, plainTheme);
			const summary = tool.renderResult!(result, { expanded: false }, plainTheme, { args });
			const expanded = tool.renderResult!(result, { expanded: true }, plainTheme, { args });
			expectWidthSafe(call);
			expectWidthSafe(summary);
			expectWidthSafe(expanded);
			expectCollapsedRowBudget(summary);
			expect(expanded.text).toBe(raw);
		}

		expect(result.content[0].text).toBe(raw);
		expect(result.details).toBe(details);
		expect(args).toEqual({ objective: "完成 Unicode 目标", token_budget: 100_000 });
	});
});
