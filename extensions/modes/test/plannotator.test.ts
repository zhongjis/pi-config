import { describe, expect, it, vi } from "vitest";

vi.mock("../../handoff/runtime.js", () => ({}));

vi.mock("../src/plan-storage.js", () => ({
	hydratePlanState: vi.fn(async () => ({
		content: "# Plan\n\n- ship feature",
		title: "Plan",
		source: "local",
	})),
}));

vi.mock("../src/plan-local.js", () => ({
	LOCAL_PLAN_URI: "local://PLAN.md",
	getLocalPlanPath: () => "/tmp/PLAN.md",
}));

vi.mock("../src/config-loader.js", () => ({
	loadAgentConfig: () => ({ body: "" }),
}));

import { ModeStateManager } from "../src/mode-state.js";
import { prepareApprovedPlanHandoff, promptPostPlanAction } from "../src/plannotator.js";

function createMockPi() {
	return {
		pi: {
			appendEntry: vi.fn(),
			getAllTools: () => [],
			setActiveTools: vi.fn(),
			setModel: vi.fn(),
			events: { emit: vi.fn() },
			sendUserMessage: vi.fn(),
		},
	};
}

function createCtx(selectResult: string | null = null) {
	return {
		hasUI: true,
		sessionManager: {
			getSessionFile: () => "/tmp/session.jsonl",
		},
		ui: {
			notify: vi.fn(),
			setEditorText: vi.fn(),
			select: vi.fn(async () => selectResult),
			editor: vi.fn(async () => undefined),
		},
	};
}

describe("plannotator handoff prep", () => {

	it("prepareApprovedPlanHandoff sets editor text to /handoff:start-work and returns success message", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.planTitle = "Ship feature";
		state.planActionPending = true;

		const ctx = createCtx();
		const result = await prepareApprovedPlanHandoff(mock.pi as never, state, ctx as never);

		expect(result.success).toBe(true);
		expect(result.message).toContain("Planning finished");
		expect(result.message).toContain("/handoff:start-work");
		expect(result.details).toMatchObject({
			mode: "houtu",
			planPath: "/tmp/PLAN.md",
		});
		expect(ctx.ui.setEditorText).toHaveBeenCalledWith("/handoff:start-work");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Planning finished"), "info");
		expect(mock.pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("promptPostPlanAction select → Approve sets editor text and sends followUp", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "fuxi";
		state.planTitle = "Ship feature";
		state.planApproved = true;
		state.planActionPending = true;
		state.planReviewApproved = true;
		state.plannotatorAvailable = true;  // skip availability network call

		const ctx = createCtx("Approve");
		await promptPostPlanAction(mock.pi as never, state, ctx as never);

		expect(ctx.ui.select).toHaveBeenCalled();
		expect(ctx.ui.setEditorText).toHaveBeenCalledWith("/handoff:start-work");
		expect(mock.pi.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("Planning finished"),
			expect.objectContaining({ deliverAs: "followUp" }),
		);
	});

	it("promptPostPlanAction select → null (escape) does nothing", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "fuxi";
		state.planTitle = "Ship feature";
		state.planActionPending = true;
		state.planReviewApproved = true;
		state.plannotatorAvailable = true;  // skip availability network call

		const ctx = createCtx(null);
		await promptPostPlanAction(mock.pi as never, state, ctx as never);

		expect(ctx.ui.select).toHaveBeenCalled();
		expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
		expect(mock.pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("promptPostPlanAction select → High accuracy review sets pending state and sends message", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "fuxi";
		state.planTitle = "Ship feature";
		state.planActionPending = true;
		state.planReviewApproved = true;
		state.plannotatorAvailable = true;  // skip availability network call

		const ctx = createCtx("High accuracy review");
		await promptPostPlanAction(mock.pi as never, state, ctx as never);

		expect(ctx.ui.select).toHaveBeenCalled();
		expect(state.highAccuracyReviewPending).toBe(true);
		// sendUserMessage is called via setTimeout; allow microtasks to flush
		await new Promise((r) => setTimeout(r, 10));
		expect(mock.pi.sendUserMessage).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ deliverAs: "followUp" }),
		);
	});
});
