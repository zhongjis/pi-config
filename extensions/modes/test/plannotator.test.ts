import { describe, expect, it, vi } from "vitest";

vi.mock("../../handoff/runtime.js", () => ({
	buildPlanExecutionGoal: vi.fn((path: string) => `Execute plan at ${path}.`),
}));

vi.mock("../src/plan-storage.js", () => ({
	hydratePlanState: vi.fn(async () => ({
		content: "# Plan\n\n- ship feature",
		title: "Plan",
		source: "local",
	})),
	getLocalPlanPath: () => "/tmp/PLAN.md",
	readLocalPlanFile: vi.fn(async () => "# Plan\n\n- ship feature"),
	writeLocalPlanFile: vi.fn(async () => {}),
}));

vi.mock("../src/constants.js", async (importOriginal) => {
	const original = await importOriginal() as Record<string, unknown>;
	return {
		...original,
		LOCAL_PLAN_URI: "local://PLAN.md",
	};
});

vi.mock("../src/config-loader.js", () => ({
	loadAgentConfig: () => ({ body: "" }),
}));

import { ModeStateManager } from "../src/mode-state.js";
import { prepareApprovedPlanHandoff } from "../src/plannotator.js";

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

function createCtx() {
	return {
		hasUI: true,
		sessionManager: {
			getSessionFile: () => "/tmp/session.jsonl",
		},
		ui: {
			notify: vi.fn(),
			setEditorText: vi.fn(),
			select: vi.fn(async () => null),
			editor: vi.fn(async () => undefined),
		},
	};
}

describe("plannotator handoff prep", () => {
	it("prepareApprovedPlanHandoff sets editor text to /handoff:start-work and returns success message", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.planTitle = "Ship feature";

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

	it("prepareApprovedPlanHandoff returns failure when no plan title is set", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);

		const ctx = createCtx();
		const result = await prepareApprovedPlanHandoff(mock.pi as never, state, ctx as never);

		expect(result.success).toBe(false);
		expect(result.level).toBe("warning");
		expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
	});
});
