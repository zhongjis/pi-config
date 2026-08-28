import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";

vi.mock("../src/plan-storage.js", () => ({
	hydratePlanState: vi.fn(async (_ctx: unknown, state?: { planContent?: string; planTitle?: string; planTitleSource?: string }) => {
		const snapshot = {
			content: "# Plan\n\n- ship feature",
			title: "Plan",
			source: "local",
		};
		if (state) {
			state.planContent = snapshot.content;
			state.planTitle = snapshot.title;
			state.planTitleSource = snapshot.source;
		}
		return snapshot;
	}),
	writeLocalPlanFile: vi.fn(async () => {}),
}));

const plannotatorMocks = vi.hoisted(() => ({
	checkPlannotatorAvailability: vi.fn(async () => ({ available: true })),
	startPlanReview: vi.fn(async () => "Got it, waiting on response from user"),
	prepareApprovedPlanHandoff: vi.fn(async () => ({
		success: true,
		message: "Planning finished",
		level: "info" as const,
	})),
}));

vi.mock("../src/plannotator.js", () => ({
	checkPlannotatorAvailability: plannotatorMocks.checkPlannotatorAvailability,
	getPlannotatorUnavailableReason: (reason?: string) => reason?.trim() || "Plannotator is unavailable.",
	startPlanReview: plannotatorMocks.startPlanReview,
	prepareApprovedPlanHandoff: plannotatorMocks.prepareApprovedPlanHandoff,
}));

import { ModeStateManager } from "../src/mode-state.js";
import { runPlanApprovalFlow } from "../src/plan-approval.js";

function createMockPi() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	return {
		events: {
			emit: vi.fn((channel: string, data: unknown) => {
				for (const listener of [...(listeners.get(channel) ?? [])]) listener(data);
			}),
			on(channel: string, listener: (data: unknown) => void) {
				const channelListeners = listeners.get(channel) ?? new Set<(data: unknown) => void>();
				channelListeners.add(listener);
				listeners.set(channel, channelListeners);
				return () => channelListeners.delete(listener);
			},
		},
		sendUserMessage: vi.fn(),
		appendEntry: vi.fn(),
		getAllTools: () => [],
		setActiveTools: vi.fn(),
		setModel: vi.fn(),
	};
}

function createMockExtensionPi() {
	const tools = new Map<string, any>();
	const pi = {
		...createMockPi(),
		registerTool: vi.fn((definition: any) => tools.set(definition.name, definition)),
		registerFlag: vi.fn(),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		on: vi.fn(),
		getFlag: vi.fn(() => "kuafu"),
	};

	return { pi, tools };
}

type RenderableText = { render?: (width?: number) => string[]; text?: string };
type PlainTheme = { fg: (color: string, text: string) => string; bold: (text: string) => string };

const plainTheme: PlainTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function renderText(component: RenderableText, width = 80): string {
	if (typeof component.render === "function") return component.render(width).join("\n");
	return component.text ?? "";
}

describe("runPlanApprovalFlow", () => {
	it("emits user-prompted before interactive approval menu and returns plannotator wait message", async () => {
		plannotatorMocks.checkPlannotatorAvailability.mockClear();
		plannotatorMocks.startPlanReview.mockClear();
		plannotatorMocks.prepareApprovedPlanHandoff.mockClear();

		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		state.planTitle = "Plan";
		state.planContent = "# Plan\n\n- ship feature";

		const ctx = {
			hasUI: true,
			ui: {
				select: vi.fn(async () => "Refine in Plannotator"),
			},
		};

		const result = await runPlanApprovalFlow(pi as never, state, ctx as never, "post-gap-review");

		expect(pi.events.emit).toHaveBeenCalledWith("user-prompted", { tool: "plan_approve" });
		expect(plannotatorMocks.startPlanReview).toHaveBeenCalledTimes(1);
		expect(result).toBe("Got it, waiting on response from user");
	});
});

describe("modes extension plan_approve tool", () => {
	it("returns a Pi 0.70-compatible tool result with details", async () => {
		plannotatorMocks.checkPlannotatorAvailability.mockClear();
		plannotatorMocks.prepareApprovedPlanHandoff.mockClear();

		const { default: initModesExtension } = await import("../src/index.js");
		const { pi, tools } = createMockExtensionPi();
		initModesExtension(pi as never);

		const tool = tools.get("plan_approve");
		expect(tool).toBeDefined();

		const result = await tool.execute("tool-1", {}, undefined, undefined, {
			hasUI: true,
			ui: {
				select: vi.fn(async () => "Approve"),
			},
		} as never);

		expect(result).toEqual({
			content: [{ type: "text", text: "Planning finished" }],
			details: { variant: "post-gap-review" },
		});
	});

	it("registers call and result renderers with variant, outcome parity, raw fallback, and no side effects", async () => {
		plannotatorMocks.checkPlannotatorAvailability.mockClear();
		plannotatorMocks.prepareApprovedPlanHandoff.mockClear();

		const { default: initModesExtension } = await import("../src/index.js");
		const { pi, tools } = createMockExtensionPi();
		initModesExtension(pi as never);
		const tool = tools.get("plan_approve");
		expect(tool.renderCall).toBeDefined();
		expect(tool.renderResult).toBeDefined();
		const eventCount = pi.events.emit.mock.calls.length;
		const appendCount = pi.appendEntry.mock.calls.length;

		expect(renderText(tool.renderCall({ variant: "post-high-accuracy" }, plainTheme))).toBe(
			"▸ plan_approve · post-high-accuracy",
		);

		const cases = [
			["Planning finished", "approved"],
			[`Error: No plan found in local://PLAN.md. Write or save the plan to local://PLAN.md first.`, "missing plan"],
			["Plan approval cancelled by user.", "cancelled"],
			["Plan approval: user selected High Accuracy Review.\nRun yanluo as a subagent with the plan content from local://PLAN.md.", "high accuracy review"],
			["Plan \"Plan\" updated via editor. Refinement feedback sent.", "editor refinement"],
			["Cannot open editor in non-interactive mode.", "editor unavailable"],
			["Got it, waiting on response from user", "plannotator refinement"],
			["Plan approval: unrecognised selection.", "unrecognised selection"],
		] as const;

		for (const [text, expected] of cases) {
			const rendered = renderText(tool.renderResult({
				content: [{ type: "text", text }],
				details: { variant: "post-gap-review" },
			}, {}, plainTheme));
			expect(rendered).toContain(expected);
		}

		const malformed = renderText(tool.renderResult({
			content: [{ type: "text", text: "raw approval fallback" }],
			details: { variant: 7 },
		}, {}, plainTheme));
		expect(malformed).toContain("raw approval fallback");

		for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
			const rendered = tool.renderResult({
				content: [{ type: "text", text: "Plan approval: user selected High Accuracy Review." }],
				details: { variant: "post-gap-review" },
			}, {}, plainTheme).render(width);
			expect(rendered.every((line: string) => visibleWidth(line) <= width)).toBe(true);
		}

		expect(pi.events.emit).toHaveBeenCalledTimes(eventCount);
		expect(pi.appendEntry).toHaveBeenCalledTimes(appendCount);
	});
});
