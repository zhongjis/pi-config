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
	function createMockPi(initialActiveTools = ["read", "write", "bash"]) {
		let activeTools = initialActiveTools;
		const pi = {
			appendEntry: vi.fn(),
			getAllTools: () => [
				{ name: "read" },
				{ name: "write" },
				{ name: "edit" },
				{ name: "bash" },
				{ name: "grep" },
				{ name: "find" },
				{ name: "ls" },
				{ name: "ask" },
				{ name: "web_search" },
				{ name: "clauderock" },
				{ name: "readonly_bash" },
				{ name: "Agent" },
				{ name: "get_subagent_result" },
				{ name: "steer_subagent" },
				{ name: "plan_approve" },
				{ name: "plan_scaffold" },
			],
			getActiveTools: () => activeTools,
			setActiveTools: vi.fn((toolNames: string[]) => {
				activeTools = toolNames;
			}),
			setModel: vi.fn(),
			getThinkingLevel: vi.fn(() => "off" as any),
			setThinkingLevel: vi.fn(),
		};
		return pi;
	}

	it("persists normalized versioned delegation policy from mode config", () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs["kuafu:default"] = {
			body: "build",
			allowDelegationTo: [" jintong ", "chengfeng", "jintong", ""],
			disallowDelegationTo: [" houtu ", "houtu", ""],
		};

		state.persistState();

		expect(pi.appendEntry).toHaveBeenCalledWith(
			"agent-mode",
			expect.objectContaining({
				delegationPolicy: {
					version: 1,
					allowDelegationTo: ["jintong", "chengfeng"],
					disallowDelegationTo: ["houtu"],
				},
			}),
		);
	});

	it("switches mode and persists state", async () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs["fuxi:default"] = { body: "plan" };

		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
		};

		await state.switchMode("fuxi", ctx as never);
		expect(state.currentMode).toBe("fuxi");
		expect(pi.appendEntry).toHaveBeenCalled();
	});

	it("reloads resources across mode-local skill boundaries", async () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		const reload = vi.fn(async () => {});
		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
			reload,
		};

		await state.switchMode("luban", ctx as never);
		await state.switchMode("kuafu", ctx as never);
		await state.switchMode("fuxi", ctx as never);
		await state.switchMode("luban", ctx as never);

		expect(reload).toHaveBeenCalledTimes(4);
	});

	it("does not require reload support when switching to a mode-local skill mode", async () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs["luban:default"] = { body: "" };

		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
		};

		await expect(state.switchMode("luban", ctx as never)).resolves.toBeUndefined();
	});

	it("cycles through modes", async () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs["kuafu:default"] = { body: "" };
		state.cachedConfigs["fuxi:default"] = { body: "" };
		state.cachedConfigs["houtu:default"] = { body: "" };
		state.cachedConfigs["luban:default"] = { body: "" };
		state.cachedConfigs["shennong:default"] = { body: "" };

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
		expect(state.currentMode).toBe("luban");
		await state.cycleMode(ctx as never);
		expect(state.currentMode).toBe("shennong");
		await state.cycleMode(ctx as never);
		expect(state.currentMode).toBe("kuafu");
	});

	it("reloads resources when switching from luban to shennong", async () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		state.currentMode = "luban";
		state.cachedConfigs["shennong:default"] = { body: "" };
		const reload = vi.fn(async () => {});

		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
			reload,
		};

		await state.switchMode("shennong", ctx as never);

		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("reloads resources when switching from shennong to kuafu (gated → non-gated)", async () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		state.currentMode = "shennong";
		state.cachedConfigs["kuafu:default"] = { body: "" };
		const reload = vi.fn(async () => {});

		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
			reload,
		};

		await state.switchMode("kuafu", ctx as never);

		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("reloads when switching kuafu to mode-local fuxi", async () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs["fuxi:default"] = { body: "" };
		const reload = vi.fn(async () => {});

		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
			reload,
		};

		await state.switchMode("fuxi", ctx as never);

		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("does not reload between modes without scoped skills", async () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		const reload = vi.fn(async () => {});
		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
			reload,
		};

		await state.switchMode("houtu", ctx as never);
		await state.switchMode("kuafu", ctx as never);

		expect(reload).not.toHaveBeenCalled();
	});

	it("does not reload on same-mode no-op", async () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs["luban:default"] = { body: "" };
		state.currentMode = "luban";
		const reload = vi.fn(async () => {});

		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
			reload,
		};

		await state.switchMode("luban", ctx as never);

		expect(reload).not.toHaveBeenCalled();
	});

	it("filters active tools from builtin_tools and extension_tools", async () => {
		const pi = createMockPi(["read", "write", "bash", "web_search"]);
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs["kuafu:default"] = {
			body: "prompt",
			builtinToolNames: ["read", "write"],
			extensionToolNames: ["web_search"],
			extensions: true,
		};

		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
		};

		await state.applyMode(ctx as never);
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "write", "web_search"]);
	});

	it("uses extension_tools: none to disable extension tools", async () => {
		const pi = createMockPi(["read", "write", "bash", "readonly_bash", "web_search", "clauderock"]);
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs["kuafu:default"] = {
			body: "prompt",
			builtinToolNames: ["read"],
			extensionToolNames: [],
			extensions: true,
		};

		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
		};

		await state.applyMode(ctx as never);
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read"]);
	});

	it("exposes readonly_bash when exactly allowlisted", async () => {
		const pi = createMockPi(["read", "write", "bash", "readonly_bash", "web_search"]);
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs["kuafu:default"] = {
			body: "prompt",
			builtinToolNames: ["read"],
			extensionToolNames: ["readonly_bash"],
			extensions: true,
		};

		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
		};

		await state.applyMode(ctx as never);
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "readonly_bash"]);
	});

	it("removes nested Agent tools unless allow_nesting is true", async () => {
		const pi = createMockPi(["read", "Agent", "get_subagent_result", "steer_subagent"]);
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs["kuafu:default"] = {
			body: "prompt",
			builtinToolNames: ["read"],
			extensionToolNames: ["Agent", "get_subagent_result", "steer_subagent"],
			extensions: true,
		};

		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
		};

		await state.applyMode(ctx as never);
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read"]);
	});


	it("does not change active tools when mode has no tool settings", async () => {
		const pi = createMockPi(["read", "write", "bash", "web_search"]);
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs["kuafu:default"] = { body: "prompt" };

		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
		};

		await state.applyMode(ctx as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("exposes Fu Xi-only planning tools only in fuxi mode", async () => {
		const pi = createMockPi(["read", "write", "plan_approve", "plan_scaffold"]);
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs["kuafu:default"] = { body: "build" };
		state.cachedConfigs["fuxi:default"] = { body: "plan" };

		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
		};

		await state.applyMode(ctx as never);
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "write"]);

		pi.setActiveTools.mockClear();
		await state.switchMode("fuxi", ctx as never);
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "write", "plan_approve", "plan_scaffold"]);
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

	it("prefers modelOverride over config.model when applying model", async () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs["kuafu:default"] = {
			body: "build",
			model: "anthropic/claude-sonnet-4:medium",
		};
		state.modelOverride = "openai/gpt-4o";

		const models = [
			{ id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" },
			{ id: "gpt-4o", name: "GPT-4o", provider: "openai" },
		];

		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry(models),
			model: undefined,
		};

		await state.applyModelFromConfig(state.cachedConfigs["kuafu:default"]!, ctx as never);
		expect(pi.setModel).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "openai", id: "gpt-4o" }),
		);
	});

	it("falls back to config.model when no override", async () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs["kuafu:default"] = {
			body: "build",
			model: "anthropic/claude-sonnet-4:medium",
		};

		const models = [
			{ id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" },
		];

		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry(models),
			model: undefined,
		};

		await state.applyModelFromConfig(state.cachedConfigs["kuafu:default"]!, ctx as never);
		expect(pi.setModel).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "anthropic", id: "claude-sonnet-4" }),
		);
	});

	it("persists modelOverride in state", () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		state.modelOverride = "openai/gpt-4o:high";
		state.persistState();
		expect(pi.appendEntry).toHaveBeenCalledWith(
			"agent-mode",
			expect.objectContaining({ modelOverride: "openai/gpt-4o:high" }),
		);
	});

	describe("loadConfig — family cache key", () => {
		it("uses family-scoped cache key", () => {
			const pi = createMockPi();
			const state = new ModeStateManager(pi as never);
			state.cachedConfigs["kuafu:default"] = { body: "default body" };
			state.cachedConfigs["kuafu:gpt"] = { body: "gpt body" };

			expect(state.loadConfig("kuafu").body).toBe("default body");
			expect(state.loadConfig("kuafu", "gpt").body).toBe("gpt body");
			expect(state.loadConfig("kuafu", "default").body).toBe("default body");
		});
	});
});
