import { describe, expect, it, vi } from "vitest";
import { parseAccessRules } from "../../lib/active-tools.js";
import { MODE_TOOL_CEILING_NAME } from "../src/constants.js";
import { resolveModelFromStr, ModeStateManager } from "../src/mode-state.js";
import type { Mode, ModeConfig } from "../src/types.js";

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
	function createMockPi(initialActiveTools = ["read", "write", "bash"], extraTools: Array<{ name: string; exposure?: string }> = []) {
		let activeTools = initialActiveTools;
		const pi = {
			appendEntry: vi.fn(),
			getAllTools: (): Array<{ name: string; exposure?: string }> => [
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
				{ name: "agent" },
				{ name: "get_agent_result" },
				{ name: "steer_subagent" },
				{ name: "plan_approve" },
				{ name: "plan_scaffold" },
				...extraTools,
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

	it("returns whether resource reload is required without calling ctx.reload", async () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		const reload = vi.fn(async () => {});
		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
			reload,
		};

		await expect(state.switchMode("fuxi", ctx as never)).resolves.toBe(true);
		await expect(state.switchMode("kuafu", ctx as never)).resolves.toBe(true);

		expect(reload).not.toHaveBeenCalled();
	});

	it("computes next mode without mutating current mode", () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);

		expect(state.currentMode).toBe("kuafu");
		expect(state.nextMode()).toBe("fuxi");
		expect(state.currentMode).toBe("kuafu");

		state.currentMode = "fuxi";
		expect(state.nextMode()).toBe("houtu");
		state.currentMode = "houtu";
		expect(state.nextMode()).toBe("kuafu");
	});

	it("returns true when leaving a mode-local skill mode", async () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		state.currentMode = "fuxi";
		state.cachedConfigs["kuafu:default"] = { body: "" };
		const reload = vi.fn(async () => {});
		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
			reload,
		};

		await expect(state.switchMode("kuafu", ctx as never)).resolves.toBe(true);
		expect(reload).not.toHaveBeenCalled();
	});

	it("returns false between modes without scoped skills", async () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		const reload = vi.fn(async () => {});
		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
			reload,
		};

		await expect(state.switchMode("houtu", ctx as never)).resolves.toBe(false);
		await expect(state.switchMode("kuafu", ctx as never)).resolves.toBe(false);

		expect(reload).not.toHaveBeenCalled();
	});

	it("returns false on same-mode no-op", async () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs["fuxi:default"] = { body: "" };
		state.currentMode = "fuxi";
		const reload = vi.fn(async () => {});
		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
			reload,
		};

		await expect(state.switchMode("fuxi", ctx as never)).resolves.toBe(false);
		expect(reload).not.toHaveBeenCalled();
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

	it("applies thinkingOverride instead of the resolved config level", async () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs["kuafu:default"] = {
			body: "build",
			model: "anthropic/claude-sonnet-4:medium",
		};
		state.thinkingOverride = "high";

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
		expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
		expect(state.applyingModelConfig).toBe(false);
	});

	it("persists thinkingOverride in state", () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		state.thinkingOverride = "high";
		state.persistState();
		expect(pi.appendEntry).toHaveBeenCalledWith(
			"agent-mode",
			expect.objectContaining({ thinkingOverride: "high" }),
		);
	});

	it("preserves model and thinking overrides across switchMode", async () => {
		const pi = createMockPi();
		const state = new ModeStateManager(pi as never);
		state.cachedConfigs["fuxi:default"] = { body: "plan" };
		state.modelOverride = "openai/gpt-4o";
		state.thinkingOverride = "high";

		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn() },
			modelRegistry: createMockRegistry([]),
		};

		await state.switchMode("fuxi", ctx as never);
		expect(state.currentMode).toBe("fuxi");
		expect(state.modelOverride).toBe("openai/gpt-4o");
		expect(state.thinkingOverride).toBe("high");
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

describe("ModeStateManager tool access", () => {
	type FixtureTool = { name: string; exposure: string; sourceInfo: { path: string } };

	const WEB_ACCESS = "/fixture/web-access/index.ts";
	const CODEGRAPH = "/fixture/codegraph/index.ts";
	const SUBAGENTS = "/fixture/subagents/index.ts";
	const GOAL = "/fixture/goal/index.ts";
	const MODES = "/fixture/modes/index.ts";

	function tool(name: string, path: string, exposure = "direct"): FixtureTool {
		return { name, exposure, sourceInfo: { path } };
	}

	function builtin(name: string): FixtureTool {
		return tool(name, `builtin:${name}`);
	}

	function createToolPi(tools: FixtureTool[], active: string[]) {
		const registry = [...tools];
		let activeTools = [...active];
		return {
			appendEntry: vi.fn(),
			getAllTools: () => registry.map((entry) => ({ ...entry })),
			getActiveTools: () => [...activeTools],
			setActiveTools: vi.fn((toolNames: string[]) => {
				activeTools = [...toolNames];
			}),
			/** A tool registered after a previous apply, not yet active. */
			addTool: (entry: FixtureTool) => {
				registry.push(entry);
			},
			setModel: vi.fn(),
			getThinkingLevel: vi.fn(() => "off"),
			setThinkingLevel: vi.fn(),
		};
	}

	function createCtx(sessionManager: Record<string, unknown> = {}) {
		return {
			hasUI: false,
			ui: { setStatus: vi.fn(), notify: vi.fn() },
			modelRegistry: createMockRegistry([]),
			sessionManager: {
				getSessionId: () => "fixture",
				getEntries: () => [],
				getBranch: () => [],
				...sessionManager,
			},
		};
	}

	function rules(text: string) {
		return parseAccessRules("tools", text).rules;
	}

	function createState(pi: ReturnType<typeof createToolPi>, configs: Partial<Record<Mode, ModeConfig>>, mode: Mode = "kuafu") {
		const state = new ModeStateManager(pi as never);
		state.currentMode = mode;
		vi.spyOn(state, "loadConfig").mockImplementation((target: Mode) => configs[target] ?? { body: "" });
		return state;
	}

	it("leaves only the ceiling active for empty tools rules", async () => {
		const pi = createToolPi(
			[builtin("read"), builtin("bash"), tool("web_search", WEB_ACCESS), tool(MODE_TOOL_CEILING_NAME, MODES, "model-only")],
			["read", "bash", "web_search", MODE_TOOL_CEILING_NAME],
		);
		const state = createState(pi, { kuafu: { body: "", toolRules: [] } });

		await state.applyToolAccess(createCtx() as never);

		expect(pi.getActiveTools()).toEqual([MODE_TOOL_CEILING_NAME]);
	});

	it("activates every direct tool but a subtracted one and no inactive codemode or deferred tool under +@all, -edit", async () => {
		const pi = createToolPi([
			builtin("read"),
			builtin("edit"),
			builtin("bash"),
			tool("web_search", WEB_ACCESS),
			tool("codemode", "builtin:codemode", "model-only"),
			tool("lookup_symbols", CODEGRAPH, "codemode"),
			tool("web_fetch", WEB_ACCESS, "deferred"),
		], ["read"]);
		const state = createState(pi, { kuafu: { body: "", toolRules: rules("+@all, -edit") } });

		await state.applyToolAccess(createCtx() as never);

		expect(pi.getActiveTools()).toEqual(["read", "bash", "web_search", "codemode"]);
	});

	it("activates a tool an @<extension> rule grants once that extension registers it late", async () => {
		const pi = createToolPi([builtin("read"), tool("web_search", WEB_ACCESS)], ["read"]);
		const state = createState(pi, { kuafu: { body: "", toolRules: rules("+read, +@web-access") } });
		const ctx = createCtx();
		await state.applyToolAccess(ctx as never);
		pi.addTool(tool("web_fetch", WEB_ACCESS));

		await state.applyToolAccess(ctx as never);

		expect(pi.getActiveTools()).toEqual(["read", "web_search", "web_fetch"]);
	});

	it("activates the deferred Goal tools that both the rules and Goal access allow", async () => {
		const goals = ["create_goal", "get_goal", "update_goal"].map((name) => tool(name, GOAL, "deferred"));
		const pi = createToolPi([builtin("read"), ...goals], ["read"]);
		const state = createState(pi, { kuafu: { body: "", toolRules: rules("+read, +get_goal, +update_goal") } });
		const ctx = createCtx({ getEntries: () => [{ type: "custom", customType: "pi-goal-access", data: { sessionId: "fixture" } }] });

		await state.applyToolAccess(ctx as never);

		expect(pi.getActiveTools()).toEqual(["read", "get_goal", "update_goal"]);
	});

	it("keeps Goal tools inactive without Goal access even under +@all", async () => {
		const goals = ["create_goal", "get_goal", "update_goal"].map((name) => tool(name, GOAL, "deferred"));
		const pi = createToolPi([builtin("read"), ...goals], ["read"]);
		const state = createState(pi, { kuafu: { body: "", toolRules: rules("+@all") } });
		const ctx = createCtx({
			getSessionFile: () => "/fixture-missing-session/session.jsonl",
			getSessionDir: () => "/fixture-missing-session",
		});

		await state.applyToolAccess(ctx as never);

		expect(pi.getActiveTools()).toEqual(["read"]);
	});

	it.each([
		["kuafu", ["read"]],
		["fuxi", ["read", "plan_approve", "plan_scaffold"]],
	] as const)("grants Fu Xi plan tools under +@all only in fuxi (%s)", async (mode: Mode, expected: readonly string[]) => {
		const pi = createToolPi([builtin("read"), tool("plan_approve", MODES), tool("plan_scaffold", MODES)], ["read"]);
		const state = createState(pi, { [mode]: { body: "", toolRules: rules("+@all") } }, mode);

		await state.applyToolAccess(createCtx() as never);

		expect(pi.getActiveTools()).toEqual(expected);
	});

	it("keeps nested agent tools when the mode file is missing", async () => {
		const agentTools = ["agent", "get_agent_result", "steer_subagent"];
		const pi = createToolPi([builtin("read"), ...agentTools.map((name) => tool(name, SUBAGENTS))], ["read", ...agentTools]);
		const state = createState(pi, { kuafu: { body: "" } });

		await state.applyToolAccess(createCtx() as never);

		expect(pi.getActiveTools()).toEqual(["read", ...agentTools]);
	});

	it("removes nested agent tools under +@all unless allow_nesting is true", async () => {
		const agentTools = ["agent", "get_agent_result", "steer_subagent"];
		const pi = createToolPi([builtin("read"), ...agentTools.map((name) => tool(name, SUBAGENTS))], ["read", ...agentTools]);
		const state = createState(pi, { kuafu: { body: "", toolRules: rules("+@all") } });

		await state.applyToolAccess(createCtx() as never);

		expect(pi.getActiveTools()).toEqual(["read"]);
	});

	it("sets active tools once when the same mode applies twice", async () => {
		const pi = createToolPi([builtin("read"), builtin("bash"), builtin("edit")], ["read", "edit"]);
		const state = createState(pi, { kuafu: { body: "", toolRules: rules("+read, +bash") } });
		const ctx = createCtx();

		await state.applyToolAccess(ctx as never);
		await state.applyToolAccess(ctx as never);

		expect(pi.setActiveTools).toHaveBeenCalledTimes(1);
	});

	it("restores Kua Fu's active tools after a round trip through Fu Xi", async () => {
		const kuafuTools = ["read", "edit", "bash", "web_search"];
		const pi = createToolPi([builtin("read"), builtin("edit"), builtin("bash"), tool("web_search", WEB_ACCESS)], kuafuTools);
		const state = createState(pi, {
			kuafu: { body: "", toolRules: rules("+@all") },
			fuxi: { body: "", toolRules: rules("+read") },
		});
		const ctx = createCtx();

		await state.switchMode("fuxi", ctx as never);
		await state.switchMode("kuafu", ctx as never);

		expect(pi.getActiveTools()).toEqual(kuafuTools);
	});

	it("notifies a resolution diagnostic once across repeated applies", async () => {
		const pi = createToolPi([builtin("read")], ["read"]);
		const state = createState(pi, { kuafu: { body: "", toolRules: rules("+read, +@missing-ext") } });
		const ctx = createCtx();

		await state.applyToolAccess(ctx as never);
		await state.applyToolAccess(ctx as never);

		expect(ctx.ui.notify.mock.calls).toEqual([[expect.stringContaining("@missing-ext"), "warning"]]);
	});
});
