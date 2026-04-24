import { describe, expect, it, vi } from "vitest";

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
	return {
		events: {
			emit: vi.fn(),
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
});
