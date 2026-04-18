import { describe, expect, it, vi } from "vitest";

vi.mock("../../handoff/runtime.js", () => ({
	buildPlanExecutionGoal: vi.fn((path: string) => `Execute plan at ${path}.`),
	requestDirectHandoffBridge: vi.fn(async () => ({ success: true, data: { command: "/handoff:start-work", sessionFile: "/tmp/session.jsonl" } })),
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
import { buildEditorRefinementMessage } from "../src/plan-approval.js";
import { computeLineDiff } from "../../lib/utils.js";

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

describe("computeLineDiff", () => {
	it("returns empty string for identical content", () => {
		expect(computeLineDiff("hello\nworld", "hello\nworld")).toBe("");
	});

	it("shows added lines", () => {
		const result = computeLineDiff("line1", "line1\nline2");
		expect(result).toContain("+line2");
		expect(result).toContain(" line1");
	});

	it("shows removed lines", () => {
		const result = computeLineDiff("line1\nline2", "line1");
		expect(result).toContain("-line2");
		expect(result).toContain(" line1");
	});

	it("shows mixed changes", () => {
		const result = computeLineDiff("a\nb\nc", "a\nX\nc");
		expect(result).toContain("-b");
		expect(result).toContain("+X");
		expect(result).toContain(" a");
		expect(result).toContain(" c");
	});

	it("handles empty old content", () => {
		const result = computeLineDiff("", "new line");
		expect(result).toContain("+new line");
	});

	it("handles empty new content", () => {
		const result = computeLineDiff("old line", "");
		expect(result).toContain("-old line");
	});
});

describe("buildEditorRefinementMessage", () => {
	it("returns no-changes message for empty diff", () => {
		const msg = buildEditorRefinementMessage("");
		expect(msg).toContain("no meaningful changes");
	});

	it("includes diff and revision instructions for non-empty diff", () => {
		const msg = buildEditorRefinementMessage("+new line\n-old line");
		expect(msg).toContain("```diff");
		expect(msg).toContain("+new line");
		expect(msg).toContain("-old line");
		expect(msg).toContain("plan_approve");
		expect(msg).toContain("local://PLAN.md");
	});
});

describe("prepareApprovedPlanHandoff bridge registration", () => {
	it("calls requestDirectHandoffBridge with correct args after persistState", async () => {
		const { requestDirectHandoffBridge } = await import("../../handoff/runtime.js");
		const mockBridge = vi.mocked(requestDirectHandoffBridge);
		mockBridge.mockClear();

		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.planTitle = "Ship feature";

		const ctx = createCtx();
		await prepareApprovedPlanHandoff(mock.pi as never, state, ctx as never);

		expect(mockBridge).toHaveBeenCalledTimes(1);
		expect(mockBridge).toHaveBeenCalledWith(mock.pi, {
			sessionFile: "/tmp/session.jsonl",
			goal: expect.stringContaining("/tmp/PLAN.md"),
			mode: "houtu",
			summarize: false,
			source: "prepareApprovedPlanHandoff",
		});
	});

	it("still returns success when bridge registration fails", async () => {
		const { requestDirectHandoffBridge } = await import("../../handoff/runtime.js");
		const mockBridge = vi.mocked(requestDirectHandoffBridge);
		mockBridge.mockClear();
		mockBridge.mockResolvedValueOnce({ success: false, error: "bridge down" });

		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.planTitle = "Ship feature";

		const ctx = createCtx();
		const result = await prepareApprovedPlanHandoff(mock.pi as never, state, ctx as never);

		expect(result.success).toBe(true);
		expect(mockBridge).toHaveBeenCalledTimes(1);
	});

	it("does not call bridge when planTitle is missing (early return)", async () => {
		const { requestDirectHandoffBridge } = await import("../../handoff/runtime.js");
		const mockBridge = vi.mocked(requestDirectHandoffBridge);
		mockBridge.mockClear();

		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		// planTitle not set

		const ctx = createCtx();
		const result = await prepareApprovedPlanHandoff(mock.pi as never, state, ctx as never);

		expect(result.success).toBe(false);
		expect(mockBridge).not.toHaveBeenCalled();
	});
});
