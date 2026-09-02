import { describe, expect, it, vi } from "vitest";
import {
	evaluateGuardScope,
	registerGuardCapability,
	SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY,
} from "../../lib/guard-registration.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	isToolCallEventType: (toolName: string, event: { toolName?: string }) => event.toolName === toolName,
	CustomEditor: class {
		constructor(..._args: unknown[]) {}
		handleInput(_data: string): void {}
		getText(): string {
			return "";
		}
	},
}));

vi.mock("@earendil-works/pi-tui", async (importOriginal: () => Promise<object>) => ({
	...await importOriginal() as object,
	Key: { tab: "tab", ctrlShift: (key: string) => `ctrl+shift+${key}` },
	matchesKey: (candidate: unknown, expected: unknown) => candidate === expected,
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

import smartToolGuards from "../../smart-tool-guards/index.js";
import modesExtension from "../src/index.js";
import { registerModeGuardScope, registerModeHooks } from "../src/hooks.js";
import { ModeStateManager } from "../src/mode-state.js";

function createMockPi() {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown | Promise<unknown>>>();
	const eventListeners = new Map<string, Set<(data: unknown) => void>>();

	return {
		pi: {
			events: {
				emit(channel: string, data: unknown) {
					for (const listener of [...(eventListeners.get(channel) ?? [])]) listener(data);
				},
				on(channel: string, listener: (data: unknown) => void) {
					const listeners = eventListeners.get(channel) ?? new Set<(data: unknown) => void>();
					listeners.add(listener);
					eventListeners.set(channel, listeners);
					return () => listeners.delete(listener);
				},
			},
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown | Promise<unknown>) {
				const next = handlers.get(event) ?? [];
				next.push(handler);
				handlers.set(event, next);
			},
			registerTool: vi.fn(),
			registerFlag: vi.fn(),
			registerCommand: vi.fn(),
			getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" }, { name: "Agent" }],
			getActiveTools: () => ["read", "write", "edit", "bash", "Agent"],
			setActiveTools: vi.fn(),
			setModel: vi.fn(),
			appendEntry: vi.fn(),
			getFlag: vi.fn(() => undefined),
			sendUserMessage: vi.fn(),
			getThinkingLevel: vi.fn(() => "off"),
			setThinkingLevel: vi.fn(),
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

type PromptFamily = "default" | "gpt" | "gemini";
type TestMode = "kuafu" | "fuxi" | "houtu" | "luban" | "shennong";

type PromptConfig = {
	body: string;
	overlays?: string;
	promptMode?: "replace" | "append";
};

async function renderInjectedPrompt({
	mode,
	family = "default",
	basePrompt = "Base prompt",
	defaultConfig = { body: "Default body", promptMode: "replace" },
	familyConfig,
}: {
	mode: TestMode;
	family?: PromptFamily;
	basePrompt?: string;
	defaultConfig?: PromptConfig;
	familyConfig?: PromptConfig;
}): Promise<string> {
	const mock = createMockPi();
	const state = new ModeStateManager(mock.pi as never);
	state.currentMode = mode;
	state.resolvedFamily = family;
	state.cachedConfigs[`${mode}:default`] = defaultConfig;
	if (family !== "default") {
		state.cachedConfigs[`${mode}:${family}`] = familyConfig ?? { body: `${family} body`, promptMode: "replace" };
	}

	registerModeHooks(mock.pi as never, state);
	const [result] = await mock.fire("before_agent_start", { systemPrompt: basePrompt }, { hasUI: false });
	return (result as { systemPrompt: string }).systemPrompt;
}

describe("mode hooks", () => {
	it("appends mode prompt with HTML markers during before_agent_start", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "fuxi";
		state.cachedConfigs["fuxi:default"] = { body: "Fu Xi prompt" };

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
		state.cachedConfigs["fuxi:default"] = { body: "" };

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

	it("blocks Fu Xi bash when smart guard capability is not registered", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "fuxi";
		state.cachedConfigs["fuxi:default"] = { body: "" };

		registerModeHooks(mock.pi as never, state);
		const [result] = await mock.fire(
			"tool_call",
			{ toolName: "bash", input: { command: "git status" } },
			{},
		);

		expect(result).toEqual({
			block: true,
			reason: expect.stringMatching(/smart guard.*not registered/i),
		});
	});

	it("passes Fu Xi bash to smart guard when capability is registered", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "fuxi";
		state.cachedConfigs["fuxi:default"] = { body: "" };
		registerGuardCapability(mock.pi as never, SMART_TOOL_GUARDS_BASH_GUARD_CAPABILITY);

		registerModeHooks(mock.pi as never, state);
		const [result] = await mock.fire(
			"tool_call",
			{ toolName: "bash", input: { command: "git status" } },
			{},
		);

		expect(result).toBeUndefined();
	});

	it("registers the Fu Xi scope provider during extension initialization", async () => {
		const mock = createMockPi();
		modesExtension(mock.pi as never);
		const event = { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: { command: "pwd" } };

		expect(await evaluateGuardScope(mock.pi as never, event as never, {} as never)).toBe("abstain");
	});

	it.each(["modes-first", "smart-tool-guards-first"] as const)(
		"keeps one guard decision across %s registration, repeats, and mode switches",
		async (order: "modes-first" | "smart-tool-guards-first") => {
			const mock = createMockPi();
			const state = new ModeStateManager(mock.pi as never);
			const registerMode = () => registerModeGuardScope(mock.pi as never, state);
			if (order === "modes-first") {
				registerMode();
				smartToolGuards(mock.pi as never);
			} else {
				smartToolGuards(mock.pi as never);
				registerMode();
			}
			smartToolGuards(mock.pi as never);
			registerMode();

			state.currentMode = "fuxi";
			const guarded = await mock.fire(
				"tool_call",
				{ type: "tool_call", toolCallId: "call-1", toolName: "bash", input: { command: "rm out" } },
				{ cwd: "/tmp" },
			);
			expect(guarded.filter((result) => result !== undefined)).toEqual([
				expect.objectContaining({ block: true }),
			]);

			state.currentMode = "houtu";
			expect(await mock.fire(
				"tool_call",
				{ type: "tool_call", toolCallId: "call-2", toolName: "bash", input: { command: "rm out" } },
				{ cwd: "/tmp" },
			)).toEqual([undefined]);
		},
	);



	it("HTML marker round-trip: strips mode A body when switching to mode B", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "fuxi";
		state.cachedConfigs["fuxi:default"] = { body: "Fu Xi planning prompt", promptMode: "replace" };
		state.cachedConfigs["kuafu:default"] = { body: "Kua Fu build prompt", promptMode: "replace" };

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

	it("injects luban prompt with HTML markers", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "luban";
		state.cachedConfigs["luban:default"] = { body: "Lu Ban prompt", promptMode: "replace" };

		registerModeHooks(mock.pi as never, state);

		const [result] = await mock.fire("before_agent_start", { systemPrompt: "Base prompt" }, { hasUI: false });

		expect(result).toEqual({
			systemPrompt: "Base prompt\n\n<!-- mode:luban -->\nLu Ban prompt\n<!-- /mode:luban -->",
		});
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

	it("empty-editor Tab submits the next /mode through the editor command path", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		const switchMode = vi.spyOn(state, "switchMode").mockResolvedValue(false);
		let editorFactory: ((tui: unknown, theme: unknown, keybindings: unknown) => unknown) | undefined;
		const onSubmit = vi.fn(async (_text: string) => {});
		const ctx = {
			mode: "tui",
			hasUI: true,
			cwd: process.cwd(),
			ui: {
				setStatus: vi.fn(),
				setEditorComponent: vi.fn((factory: typeof editorFactory) => {
					editorFactory = factory;
				}),
			},
			modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined },
			sessionManager: { getEntries: () => [], getSessionId: () => "mode-hooks-tab-test" },
		};

		registerModeHooks(mock.pi as never, state);
		await mock.fire("session_start", {}, ctx);
		expect(editorFactory).toBeDefined();
		const editor = editorFactory?.({}, {}, {}) as { handleInput(data: string): void; onSubmit?: typeof onSubmit };
		editor.onSubmit = onSubmit;

		editor.handleInput("tab");

		expect(switchMode).not.toHaveBeenCalled();
		expect(onSubmit).toHaveBeenCalledWith("/mode:fuxi");
	});

	it("Ctrl+Shift+M submits the next /mode through ModeEditor and preserves drafted text", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		const switchMode = vi.spyOn(state, "switchMode").mockResolvedValue(false);
		let editorFactory: ((tui: unknown, theme: unknown, keybindings: unknown) => unknown) | undefined;
		const onSubmit = vi.fn(async (_text: string) => {});
		const ctx = {
			mode: "tui",
			hasUI: true,
			cwd: process.cwd(),
			ui: {
				setStatus: vi.fn(),
				setEditorComponent: vi.fn((factory: typeof editorFactory) => {
					editorFactory = factory;
				}),
			},
			modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined },
			sessionManager: { getEntries: () => [], getSessionId: () => "mode-hooks-shortcut-test" },
		};

		registerModeHooks(mock.pi as never, state);
		await mock.fire("session_start", {}, ctx);
		expect(editorFactory).toBeDefined();
		const editor = editorFactory?.({}, {}, {}) as {
			handleInput(data: string): void;
			getText(): string;
			onSubmit?: typeof onSubmit;
		};
		editor.onSubmit = onSubmit;
		editor.getText = vi.fn(() => "draft text");

		editor.handleInput("ctrl+shift+m");

		expect(switchMode).not.toHaveBeenCalled();
		expect(onSubmit).toHaveBeenCalledWith("/mode:fuxi");
		expect(editor.getText()).toBe("draft text");
	});

	it("re-applies mode model on model_select restore", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "kuafu";
		state.cachedConfigs["kuafu:default"] = {
			body: "build",
			model: "anthropic/claude-sonnet-4:medium",
		};

		registerModeHooks(mock.pi as never, state);

		const registry = {
			getAll: () => [{ id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" }],
			getAvailable: () => [{ id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" }],
			find: (provider: string, modelId: string) =>
				({ id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" }),
		};

		await mock.fire("model_select", { source: "restore", model: {}, previousModel: {} }, {
			modelRegistry: registry,
			model: undefined,
		});

		expect(mock.pi.setModel).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "anthropic", id: "claude-sonnet-4" }),
		);
	});

	it("ignores model_select when source is not restore", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "kuafu";
		state.cachedConfigs["kuafu:default"] = {
			body: "build",
			model: "anthropic/claude-sonnet-4:medium",
		};

		registerModeHooks(mock.pi as never, state);

		await mock.fire("model_select", { source: "set", model: {}, previousModel: {} }, {
			modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined },
			model: undefined,
		});

		expect(mock.pi.setModel).not.toHaveBeenCalled();
	});

	it("uses gpt variant body when resolvedFamily is gpt", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "kuafu";
		state.cachedConfigs["kuafu:gpt"] = { body: "GPT variant body" };
		state.cachedConfigs["kuafu:default"] = { body: "default body" };
		state.resolvedFamily = "gpt";

		registerModeHooks(mock.pi as never, state);

		const [result] = await mock.fire("before_agent_start", { systemPrompt: "Base" }, { hasUI: false });
		expect(result).toEqual({
			systemPrompt: "Base\n\n<!-- mode:kuafu -->\nGPT variant body\n<!-- /mode:kuafu -->",
		});
	});

	it("injects gemini overlays before <critical> when resolvedFamily is gemini", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "kuafu";
		state.cachedConfigs["kuafu:gemini"] = {
			body: "before\n\n<critical>\nafter",
			overlays: "<GEMINI_INTENT_GATE>must classify</GEMINI_INTENT_GATE>",
		};
		state.cachedConfigs["kuafu:default"] = { body: "before\n\n<critical>\nafter" };
		state.resolvedFamily = "gemini";

		registerModeHooks(mock.pi as never, state);

		const [result] = await mock.fire("before_agent_start", { systemPrompt: "" }, { hasUI: false });
		const sp = (result as { systemPrompt: string }).systemPrompt;
		expect(sp).toContain("<GEMINI_INTENT_GATE>must classify</GEMINI_INTENT_GATE>");
		const overlayPos = sp.indexOf("<GEMINI_INTENT_GATE>");
		const criticalPos = sp.indexOf("<critical>");
		expect(overlayPos).toBeLessThan(criticalPos);
	});

	it("injects gemini overlays after </role> when no <critical> anchor exists", async () => {
		const overlay = "<GEMINI_ROLE_FALLBACK>after role</GEMINI_ROLE_FALLBACK>";
		const prompt = await renderInjectedPrompt({
			mode: "kuafu",
			family: "gemini",
			defaultConfig: { body: "<role>\nRole only\n</role>\n\nBody", promptMode: "replace" },
			familyConfig: {
				body: "<role>\nRole only\n</role>\n\nBody",
				overlays: overlay,
				promptMode: "replace",
			},
		});

		expect(prompt.indexOf(overlay)).toBeGreaterThan(prompt.indexOf("</role>"));
		expect(prompt.indexOf(overlay)).toBeLessThan(prompt.indexOf("Body"));
	});

	it("appends gemini overlays when no <critical> or </role> anchors exist", async () => {
		const overlay = "<GEMINI_APPEND_FALLBACK>append</GEMINI_APPEND_FALLBACK>";
		const prompt = await renderInjectedPrompt({
			mode: "kuafu",
			family: "gemini",
			defaultConfig: { body: "Plain body", promptMode: "replace" },
			familyConfig: { body: "Plain body", overlays: overlay, promptMode: "replace" },
		});

		expect(prompt.indexOf(overlay)).toBeGreaterThan(prompt.indexOf("Plain body"));
		expect(prompt).toContain(`${overlay}\n<!-- /mode:kuafu -->`);
	});
});
