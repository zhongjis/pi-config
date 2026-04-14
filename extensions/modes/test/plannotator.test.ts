import { describe, expect, it, vi } from "vitest";

const { requestDirectHandoffBridgeMock } = vi.hoisted(() => ({
	requestDirectHandoffBridgeMock: vi.fn(async () => ({
		success: true as const,
		data: {
			command: "/handoff:continue",
			sessionFile: "/tmp/session.jsonl",
			source: "modes",
		},
	})),
}));

vi.mock("../../handoff/runtime.js", () => ({
	buildPlanExecutionGoal: (planPath: string) =>
		[`Execute work described in approved plan at ${planPath}.`, "- Read the full plan before making changes."].join("\n"),
	getPreparedHandoffCommand: () => "/handoff:continue",
	requestDirectHandoffBridge: requestDirectHandoffBridgeMock,
}));

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

function createCtx(confirmResult = true, selectResult: string | null = null) {
	return {
		hasUI: true,
		sessionManager: {
			getSessionFile: () => "/tmp/session.jsonl",
		},
		ui: {
			notify: vi.fn(),
			setEditorText: vi.fn(),
			confirm: vi.fn(async () => confirmResult),
			select: vi.fn(async () => selectResult),
			editor: vi.fn(async () => undefined),
		},
	};
}

describe("plannotator handoff prep", () => {

	it("prepares direct handoff bridge and prefills /handoff:continue instead of queuing /handoff text", async () => {
		requestDirectHandoffBridgeMock.mockClear();
		requestDirectHandoffBridgeMock.mockResolvedValue({
			success: true,
			data: {
				command: "/handoff:continue",
				sessionFile: "/tmp/session.jsonl",
				source: "modes",
			},
		});
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.planTitle = "Ship feature";
		state.planActionPending = true;

		const ctx = createCtx();
		const result = await prepareApprovedPlanHandoff(mock.pi as never, state, ctx as never);

		expect(result.success).toBe(true);
		expect(result.details).toMatchObject({
			bridgeCommand: "/handoff:continue",
			mode: "houtu",
			planPath: "/tmp/PLAN.md",
		});
		expect(requestDirectHandoffBridgeMock).toHaveBeenCalledWith(mock.pi, {
			sessionFile: "/tmp/session.jsonl",
			goal: expect.stringContaining("/tmp/PLAN.md"),
			mode: "houtu",
			summarize: false,
			source: "modes",
		});
		expect(mock.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(ctx.ui.setEditorText).toHaveBeenCalledWith("/handoff:continue");
	});

	it("confirm=true auto-dispatches /handoff:continue via sendUserMessage", async () => {
		requestDirectHandoffBridgeMock.mockClear();
		requestDirectHandoffBridgeMock.mockResolvedValue({
			success: true,
			data: {
				command: "/handoff:continue",
				sessionFile: "/tmp/session.jsonl",
				source: "modes",
			},
		});
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "fuxi";
		state.planTitle = "Ship feature";
		state.planApproved = true;
		state.planActionPending = true;
		state.planReviewApproved = true;

		const ctx = createCtx(true);
		await promptPostPlanAction(mock.pi as never, state, ctx as never);

		expect(ctx.ui.confirm).toHaveBeenCalled();
		expect(requestDirectHandoffBridgeMock).toHaveBeenCalledWith(
			mock.pi,
			expect.objectContaining({ mode: "houtu", summarize: false }),
		);
		expect(mock.pi.sendUserMessage).toHaveBeenCalledWith(
			"/handoff:continue",
			expect.objectContaining({ deliverAs: "followUp" }),
		);
		expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
	});

	it("confirm=false shows secondary options menu and does not dispatch", async () => {
		requestDirectHandoffBridgeMock.mockClear();
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "fuxi";
		state.planTitle = "Ship feature";
		state.planActionPending = true;
		state.planReviewApproved = true;  // skip Plannotator availability check

		const ctx = createCtx(false, null);
		await promptPostPlanAction(mock.pi as never, state, ctx as never);

		expect(ctx.ui.confirm).toHaveBeenCalled();
		expect(ctx.ui.select).toHaveBeenCalled();
		expect(mock.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(requestDirectHandoffBridgeMock).not.toHaveBeenCalled();
	});
});
