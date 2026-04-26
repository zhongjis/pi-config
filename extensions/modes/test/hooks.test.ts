import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-coding-agent", () => ({
	CustomEditor: class {
		constructor(..._args: unknown[]) {}
		handleInput(_data: string): void {}
		getText(): string {
			return "";
		}
	},
}));

vi.mock("@mariozechner/pi-tui", () => ({
	Key: { tab: "tab" },
	matchesKey: () => false,
}));

vi.mock("../src/config-loader.js", () => ({
	loadAgentConfig: () => ({ body: "" }),
}));

vi.mock("../src/plannotator.js", () => ({
	recoverPlanReview: vi.fn(async () => {}),
}));

vi.mock("../src/plan-storage.js", () => ({
	LOCAL_PLAN_URI: "local://PLAN.md",
	LOCAL_DRAFT_URI: "local://DRAFT.md",
	getLocalPlanPath: () => "/tmp/PLAN.md",
	getLocalDraftPath: () => "/tmp/DRAFT.md",
	readLocalPlanFile: vi.fn(async () => "# Plan\n\n- item"),
	derivePlanTitleFromMarkdown: vi.fn((content: string) => {
		const match = content.match(/^\s{0,3}#\s+(.+?)\s*$/mu);
		return match ? match[1].trim() : undefined;
	}),
	hydratePlanState: vi.fn(async () => undefined),
}));

import { registerModeHooks } from "../src/hooks.js";
import { ModeStateManager } from "../src/mode-state.js";

function createMockPi() {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown | Promise<unknown>>>();

	return {
		pi: {
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown | Promise<unknown>) {
				const next = handlers.get(event) ?? [];
				next.push(handler);
				handlers.set(event, next);
			},
			getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" }, { name: "Agent" }],
			setActiveTools: vi.fn(),
			setModel: vi.fn(),
			appendEntry: vi.fn(),
			getFlag: vi.fn(() => undefined),
			sendUserMessage: vi.fn(),
		},
		async fire(event: string, payload: unknown, ctx: unknown) {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) {
				results.push(await handler(payload, ctx));
			}
			return results;
		},
	};
}

describe("mode hooks", () => {
	it("appends mode prompt with HTML markers during before_agent_start", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "fuxi";
		state.cachedConfigs.fuxi = { body: "Fu Xi prompt" };

		registerModeHooks(mock.pi as never, state);

		const [result] = await mock.fire("before_agent_start", { systemPrompt: "Base prompt" }, { hasUI: false });
		expect(result).toEqual({
			systemPrompt: "Base prompt\n\n<!-- mode:fuxi -->\nFu Xi prompt\n<!-- /mode:fuxi -->",
		});
	});

	it("blocks plan-mode writes outside local://PLAN.md", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "fuxi";
		state.cachedConfigs.fuxi = { body: "" };

		registerModeHooks(mock.pi as never, state);

		const [result] = await mock.fire(
			"tool_call",
			{ toolName: "write", input: { path: "src/app.ts" } },
			{ sessionManager: { getSessionId: () => "session-1" } },
		);

		expect(result).toMatchObject({
			block: true,
			reason: expect.stringContaining("local://PLAN.md"),
		});
	});

	it("blocks built-in bash commands in plan mode", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "fuxi";
		state.cachedConfigs.fuxi = { body: "" };

		registerModeHooks(mock.pi as never, state);

		for (const command of ["cat README.md", "npm install express"]) {
			const [result] = await mock.fire(
				"tool_call",
				{ toolName: "bash", input: { command } },
				{},
			);

			expect(result).toMatchObject({
				block: true,
				reason: expect.stringContaining("full bash is unavailable"),
			});
			expect((result as { reason: string }).reason).toContain("readonly_bash");
		}
	});

	it("blocks delegation when frontmatter disallows target", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "kuafu";
		state.cachedConfigs.kuafu = {
			body: "build prompt",
			allowDelegationTo: ["jintong", "chengfeng"],
		};

		registerModeHooks(mock.pi as never, state);

		const [result] = await mock.fire(
			"tool_call",
			{ toolName: "Agent", input: { subagent_type: "taishang" } },
			{},
		);

		expect(result).toMatchObject({
			block: true,
			reason: expect.stringContaining("delegation to \"taishang\" is blocked"),
		});
	});

	it("allows delegation when target is in allow list", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "kuafu";
		state.cachedConfigs.kuafu = {
			body: "build prompt",
			allowDelegationTo: ["jintong", "chengfeng"],
		};

		registerModeHooks(mock.pi as never, state);

		const [result] = await mock.fire(
			"tool_call",
			{ toolName: "Agent", input: { subagent_type: "jintong" } },
			{},
		);

		expect(result).toBeUndefined();
	});

	it("HTML marker round-trip: strips mode A body when switching to mode B", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "fuxi";
		state.cachedConfigs.fuxi = { body: "Fu Xi planning prompt", promptMode: "replace" };
		state.cachedConfigs.kuafu = { body: "Kua Fu build prompt", promptMode: "replace" };

		registerModeHooks(mock.pi as never, state);

		// First call injects fuxi body
		const [result1] = await mock.fire("before_agent_start", { systemPrompt: "Base" }, { hasUI: false });
		const systemPromptAfterFuxi = (result1 as { systemPrompt: string }).systemPrompt;
		expect(systemPromptAfterFuxi).toContain("<!-- mode:fuxi -->");
		expect(systemPromptAfterFuxi).toContain("Fu Xi planning prompt");

		// Switch to kuafu — should strip fuxi body and inject kuafu body
		state.currentMode = "kuafu";
		const [result2] = await mock.fire("before_agent_start", { systemPrompt: systemPromptAfterFuxi }, { hasUI: false });
		const systemPromptAfterKuafu = (result2 as { systemPrompt: string }).systemPrompt;

		expect(systemPromptAfterKuafu).not.toContain("<!-- mode:fuxi -->");
		expect(systemPromptAfterKuafu).not.toContain("Fu Xi planning prompt");
		expect(systemPromptAfterKuafu).toContain("<!-- mode:kuafu -->");
		expect(systemPromptAfterKuafu).toContain("Kua Fu build prompt");
		expect(systemPromptAfterKuafu).toContain("Base");
	});

	it("rebinds activeCtx on session_switch and session_tree", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		registerModeHooks(mock.pi as never, state);

		const switchCtx = { sessionManager: { getSessionId: () => "switch" } };
		const treeCtx = { sessionManager: { getSessionId: () => "tree" } };

		await mock.fire("session_switch", { reason: "new" }, switchCtx);
		expect(state.activeCtx).toBe(switchCtx as never);

		await mock.fire("session_tree", {}, treeCtx);
		expect(state.activeCtx).toBe(treeCtx as never);
	});

});
