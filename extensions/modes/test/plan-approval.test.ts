import { describe, expect, it, vi } from "vitest";

vi.mock("../src/plan-storage.js", () => ({
	hydratePlanState: vi.fn(async () => ({
		content: "# Plan\n\n- ship feature",
		title: "Plan",
		source: "local",
	})),
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
