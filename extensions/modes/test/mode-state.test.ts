import { describe, expect, it, vi } from "vitest";
import { resolveModelFromStr, ModeStateManager } from "../src/mode-state.js";

vi.mock("../src/config-loader.js", () => ({
	loadAgentConfig: () => ({ body: "" }),
}));

function createMockRegistry(models: Array<{ id: string; name: string; provider: string }>) {
	return {
		getAll: () => models,
		getAvailable: () => models,
		find: (provider: string, modelId: string) => {
			return models.find((m) => m.provider === provider && m.id === modelId) ?? undefined;
		},
	};
}

describe("resolveModelFromStr", () => {
	const models = [
		{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic" },
		{ id: "claude-opus-4-20250514", name: "Claude Opus 4", provider: "anthropic" },
		{ id: "gpt-4o", name: "GPT-4o", provider: "openai" },
	];

	it("exact provider/modelId match", () => {
		const registry = createMockRegistry(models);
		const result = resolveModelFromStr("anthropic/claude-sonnet-4-20250514", registry);
		expect(result).toEqual(models[0]);
	});

	it("exact modelId match", () => {
		const registry = createMockRegistry(models);
		const result = resolveModelFromStr("gpt-4o", registry);
		expect(result).toEqual(models[2]);
	});

	it("prefix match on modelId", () => {
		const registry = createMockRegistry(models);
		const result = resolveModelFromStr("claude-sonnet", registry);
		expect(result).toEqual(models[0]);
	});

	it("returns undefined for no match", () => {
		const registry = createMockRegistry(models);
		const result = resolveModelFromStr("nonexistent-model", registry);
		expect(result).toBeUndefined();
	});
});

describe("ModeStateManager", () => {
	function createMockPi(activeTools = ["read", "write", "bash"]) {
		return {
			appendEntry: vi.fn(),
			getAllTools: () => [
				{ name: "read" },
				{ name: "write" },
				{ name: "bash" },
				{ name: "grep" },
				{ name: "find" },
				{ name: "ls" },
				{ name: "web_search" },
				{ name: "clauderock" },
				{ name: "readonly_bash" },
			],
			getActiveTools: () => activeTools,
			setActiveTools: vi.fn(),
			setModel: vi.fn(),
		};
	}

	it("switches mode and persists state", async () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs.fuxi = { body: "plan" };

		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
		};

		await state.switchMode("fuxi", ctx as never);
		expect(state.currentMode).toBe("fuxi");
		expect(pi.appendEntry).toHaveBeenCalled();
	});

	it("cycles through modes", async () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs.kuafu = { body: "" };
		state.cachedConfigs.fuxi = { body: "" };
		state.cachedConfigs.houtu = { body: "" };

		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
		};

		expect(state.currentMode).toBe("kuafu");
		await state.cycleMode(ctx as never);
		expect(state.currentMode).toBe("fuxi");
		await state.cycleMode(ctx as never);
		expect(state.currentMode).toBe("houtu");
		await state.cycleMode(ctx as never);
		expect(state.currentMode).toBe("kuafu");
	});

	it("filters tools based on whitelist without enabling extra built-ins", async () => {
		const pi = createMockPi(["read", "write", "bash", "web_search"]);
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs.kuafu = { body: "prompt", tools: ["read", "write"] };

		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
		};

		await state.applyMode(ctx as never);
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "write", "web_search"]);
	});

	it("filters readonly_bash from inherited extension tools only", async () => {
		const pi = createMockPi(["read", "write", "bash", "readonly_bash", "web_search", "clauderock"]);
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs.kuafu = { body: "prompt", tools: ["read"] };

		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
		};

		await state.applyMode(ctx as never);
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "web_search", "clauderock"]);
	});

	it("exposes readonly_bash when exactly allowlisted", async () => {
		const pi = createMockPi(["read", "write", "bash", "readonly_bash", "web_search"]);
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs.kuafu = { body: "prompt", tools: ["read"], extensions: ["readonly_bash"] };

		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
		};

		await state.applyMode(ctx as never);
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "readonly_bash"]);
	});

	it("filters readonly_bash from disallowed-tools-only modes unless exactly allowlisted", async () => {
		const pi = createMockPi(["read", "write", "readonly_bash", "web_search"]);
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs.kuafu = { body: "prompt", disallowedTools: ["bash"] };

		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
		};

		await state.applyMode(ctx as never);
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "write", "web_search"]);
	});

	it("filters tools based on blacklist from the current active set", async () => {
		const pi = createMockPi(["read", "write", "bash", "web_search"]);
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs.kuafu = { body: "prompt", disallowedTools: ["bash"] };

		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
		};

		await state.applyMode(ctx as never);
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "write", "web_search"]);
	});

	it("does not change active tools when mode has no tool settings", async () => {
		const pi = createMockPi(["read", "write", "bash", "web_search"]);
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs.kuafu = { body: "prompt" };

		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
		};

		await state.applyMode(ctx as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("resets plan review state", () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		state.pendingPlanReviewId = "review-123";
		state.planReviewPending = true;
		state.awaitingUserAction = {
			kind: "plannotator-review",
			suppressContinuationReminder: true,
		};
		state.planReviewApproved = true;
		state.planReviewFeedback = "some feedback";

		state.resetPlanReviewState();

		expect(state.pendingPlanReviewId).toBeUndefined();
		expect(state.planReviewPending).toBe(false);
		expect(state.awaitingUserAction).toBeUndefined();
		expect(state.planReviewApproved).toBe(false);
		expect(state.planReviewFeedback).toBeUndefined();
	});
});
