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
	loadAgentConfig: () => ({ body: "", toolRules: [] }),
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

import { parseAccessRules } from "../../lib/active-tools.js";
import smartToolGuards from "../../smart-tool-guards/index.js";
import { MODE_TOOL_CEILING_NAME } from "../src/constants.js";
import modesExtension from "../src/index.js";
import { registerModeGuardScope, registerModeHooks } from "../src/hooks.js";
import { ModeStateManager } from "../src/mode-state.js";

type MockTool = { name: string; exposure?: string; sourceInfo?: { path: string } };
type MockToolDefinition = {
	name: string;
	exposure?: string;
	prepareLoadout?: (loadout: unknown) => { hiddenDeclarations?: readonly string[] } | undefined;
};

const MODES_PATH = "/fixture/modes/src/index.ts";
const DEFAULT_TOOLS: MockTool[] = [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" }, { name: "agent" }];

function activatesOnRegistration(tool: MockTool): boolean {
	return tool.exposure === undefined || tool.exposure === "direct" || tool.exposure === "model-only";
}

function createMockPi(tools: MockTool[] = DEFAULT_TOOLS) {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown | Promise<unknown>>>();
	const eventListeners = new Map<string, Set<(data: unknown) => void>>();
	const registry = new Map(tools.map((tool) => [tool.name, tool]));
	const definitions = new Map<string, MockToolDefinition>();
	let activeTools = tools.map((tool) => tool.name);

	/** Registers a tool the way Pi does after binding: `direct`/`model-only` tools activate. */
	function addTool(tool: MockTool): void {
		registry.set(tool.name, tool);
		if (activatesOnRegistration(tool)) activeTools = [...activeTools.filter((name) => name !== tool.name), tool.name];
	}

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
			registerTool: vi.fn((definition: MockToolDefinition) => {
				definitions.set(definition.name, definition);
				addTool({ name: definition.name, exposure: definition.exposure, sourceInfo: { path: MODES_PATH } });
			}),
			registerFlag: vi.fn(),
			registerCommand: vi.fn(),
			getAllTools: () => [...registry.values()],
			getActiveTools: () => [...activeTools],
			setActiveTools: vi.fn((toolNames: string[]) => {
				activeTools = [...toolNames];
			}),
			setModel: vi.fn(async () => true),
			appendEntry: vi.fn(),
			getFlag: vi.fn(() => undefined),
			sendMessage: vi.fn(),
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
		addTool,
		/** Declarations a request leaves out, as Pi's loadout step collects them from active tools' `prepareLoadout`. */
		hiddenDeclarations(): string[] {
			const declared = activeTools.filter((name) => registry.get(name)?.exposure !== "hidden").map((name) => ({ name }));
			const loadout = { declared, callable: [], registered: [], getExposure: () => "direct", getNamespace: () => undefined };
			const hidden = new Set<string>();
			for (const name of activeTools) {
				for (const hiddenName of definitions.get(name)?.prepareLoadout?.(loadout)?.hiddenDeclarations ?? []) hidden.add(hiddenName);
			}
			return [...hidden].sort();
		},
	};
}

function createSessionCtx(sessionFile?: string, entries: unknown[] = []) {
	return {
		hasUI: false,
		ui: { setStatus: vi.fn(), notify: vi.fn() },
		modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined },
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => [],
			getSessionId: () => "fixture",
			getSessionFile: () => sessionFile,
		},
	};
}

function toolRules(text: string) {
	return parseAccessRules("tools", text).rules;
}

type PromptFamily = "default" | "gpt" | "gemini";
type TestMode = "kuafu" | "fuxi" | "houtu";

type PromptConfig = {
	body: string;
	overlays?: string;
};

async function renderInjectedPrompt({
	mode,
	family = "default",
	basePrompt = "Base prompt",
	defaultConfig = { body: "Default body" },
	familyConfig,
}: {
	mode: TestMode;
	family?: PromptFamily;
	basePrompt?: string;
	defaultConfig?: PromptConfig;
	familyConfig?: PromptConfig;
}): Promise<string | undefined> {
	const mock = createMockPi();
	const state = new ModeStateManager(mock.pi as never);
	state.currentMode = mode;
	state.resolvedFamily = family;
	state.cachedConfigs[`${mode}:default`] = { ...defaultConfig, toolRules: [] };
	if (family !== "default") {
		state.cachedConfigs[`${mode}:${family}`] = { ...(familyConfig ?? { body: `${family} body` }), toolRules: [] };
	}

	registerModeHooks(mock.pi as never, state);
	const event = beforeAgentStartEvent(basePrompt);
	const [result] = await mock.fire("before_agent_start", event, { hasUI: false });
	expect(result).toBeUndefined();
	return event.systemPromptOptions.sections.modes;
}

function beforeAgentStartEvent(systemPrompt: string, sections: Record<string, string> = {}) {
	return { type: "before_agent_start", prompt: "", systemPrompt, systemPromptOptions: { sections } };
}

describe("mode hooks", () => {
	it.each(["unknown", "", null, undefined, 42, {}, []])(
		"discards invalid saved mode %j and its associated state", async (mode: unknown) => {
			const mock = createMockPi();
			const state = new ModeStateManager(mock.pi as never);
			registerModeHooks(mock.pi as never, state);
			await mock.fire("session_start", {}, {
				hasUI: false, ui: { setStatus: vi.fn() },
				modelRegistry: { getAll: () => [], getAvailable: () => [] },
				sessionManager: { getSessionId: () => "invalid-mode", getEntries: () => [{
					type: "custom", customType: "agent-mode", data: { mode, modelOverride: "stale/model",
						planTitle: "stale", planTitleSource: "cached-state", planContent: "stale",
						planReviewId: "stale", planReviewPending: true, planReviewApproved: true,
						planReviewFeedback: "stale", awaitingUserAction: { kind: "plannotator-review" } },
				}] },
			});
			expect(state.currentMode).toBe("kuafu");
			for (const value of [state.modelOverride, state.planTitle, state.planTitleSource, state.planContent,
				state.pendingPlanReviewId, state.planReviewFeedback, state.awaitingUserAction]) expect(value).toBeUndefined();
			expect(state.planReviewPending).toBe(false);
			expect(state.planReviewApproved).toBe(false);
		},
	);

	it.each([undefined, "kuafu", "houtu", "execute", "invalid"] )(
		"preserves CLI precedence and valid saved state with flag %j", async (flag: string | undefined) => {
			const mock = createMockPi();
			vi.spyOn(mock.pi, "getFlag").mockImplementation(() => flag as never);
			const state = new ModeStateManager(mock.pi as never);
			registerModeHooks(mock.pi as never, state);
			await mock.fire("session_start", {}, {
				hasUI: false, ui: { setStatus: vi.fn() },
				modelRegistry: { getAll: () => [], getAvailable: () => [] },
				sessionManager: { getSessionId: () => "valid-mode", getEntries: () => [{
					type: "custom", customType: "agent-mode", data: { mode: "fuxi", modelOverride: "saved/model",
						planReviewId: "review", planReviewPending: true, planContent: "plan" },
				}] },
			});
			const restores = !flag || flag === "kuafu";
			expect(state.currentMode).toBe(restores ? "fuxi" : flag === "invalid" ? "kuafu" : "houtu");
			expect(state.modelOverride).toBe(restores ? "saved/model" : undefined);
			expect(state.pendingPlanReviewId).toBe(restores ? "review" : undefined);
			expect(state.planReviewPending).toBe(restores);
			expect(state.planContent).toBe(restores ? "plan" : undefined);
		},
	);
	it("publishes the mode body as the modes prompt section during before_agent_start", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "fuxi";
		state.cachedConfigs["fuxi:default"] = { body: "Fu Xi prompt", toolRules: [] };

		registerModeHooks(mock.pi as never, state);

		const event = beforeAgentStartEvent("Base prompt", { other: "kept" });
		const [result] = await mock.fire("before_agent_start", event, { hasUI: false });
		expect(result).toBeUndefined();
		expect(event.systemPrompt).toBe("Base prompt");
		expect(event.systemPromptOptions.sections).toEqual({ other: "kept", modes: "Fu Xi prompt" });
	});

	it("sets no modes section when the mode has no body", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.cachedConfigs["kuafu:default"] = { body: "", toolRules: [] };
		registerModeHooks(mock.pi as never, state);

		const event = beforeAgentStartEvent("Base");
		const [result] = await mock.fire("before_agent_start", event, { hasUI: false });
		expect(result).toBeUndefined();
		expect(event.systemPromptOptions.sections).toEqual({});
	});

	it("sets no modes section in subagent sessions", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.cachedConfigs["kuafu:default"] = { body: "Kua Fu build prompt", toolRules: [] };
		registerModeHooks(mock.pi as never, state);

		const event = beforeAgentStartEvent("Base");
		const [result] = await mock.fire("before_agent_start", event, {
			hasUI: false,
			sessionManager: { getSessionFile: () => "/tmp/subagent-sessions/child.jsonl" },
		});
		expect(result).toBeUndefined();
		expect(event.systemPromptOptions.sections).toEqual({});
	});

	it("blocks plan-mode writes outside local://PLAN.md", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "fuxi";
		state.cachedConfigs["fuxi:default"] = { body: "", toolRules: toolRules("+@all") };

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
		state.cachedConfigs["fuxi:default"] = { body: "", toolRules: toolRules("+@all") };

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
		state.cachedConfigs["fuxi:default"] = { body: "", toolRules: toolRules("+@all") };
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

		expect(await evaluateGuardScope(mock.pi as never, event as never, {} as never)).toEqual({ decision: "abstain" });
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
			expect(await evaluateGuardScope(mock.pi as never, {
				type: "tool_call",
				toolCallId: "scope-call",
				toolName: "bash",
				input: { command: "pwd" },
			} as never, {} as never)).toEqual({
				decision: "guard",
				activeScopes: [{
					id: "modes:fuxi",
					reason: "Fuxi plan mode requires read-only Bash.",
				}],
			});
			const guarded = await mock.fire(
				"tool_call",
				{ type: "tool_call", toolCallId: "call-1", toolName: "bash", input: { command: "rm out" } },
				{ cwd: "/tmp" },
			);
			expect(guarded.filter((result) => result !== undefined)).toEqual([{
				block: true,
				reason: [
					"[Smart Guard][BLOCK][source=policy][profile=bash-read-only-v1][scope=modes:fuxi]",
					"Bash not run: Read-only policy matched: filesystem-mutation. Guard active: Fuxi plan mode requires read-only Bash.",
				].join("\n"),
			}]);

			state.currentMode = "houtu";
			expect(await mock.fire(
				"tool_call",
				{ type: "tool_call", toolCallId: "call-2", toolName: "bash", input: { command: "rm out" } },
				{ cwd: "/tmp" },
			)).toEqual([undefined]);
		},
	);



	it("switching mode replaces the modes section content", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "fuxi";
		state.cachedConfigs["fuxi:default"] = { body: "Fu Xi planning prompt", toolRules: [] };
		state.cachedConfigs["kuafu:default"] = { body: "Kua Fu build prompt", toolRules: [] };

		registerModeHooks(mock.pi as never, state);

		const sections: Record<string, string> = { other: "kept" };
		await mock.fire("before_agent_start", beforeAgentStartEvent("Base", sections), { hasUI: false });
		expect(sections.modes).toBe("Fu Xi planning prompt");

		state.currentMode = "kuafu";
		await mock.fire("before_agent_start", beforeAgentStartEvent("Base", sections), { hasUI: false });
		expect(sections.modes).toBe("Kua Fu build prompt");
		expect(sections.other).toBe("kept");
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
			toolRules: [],
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
			toolRules: [],
			model: "anthropic/claude-sonnet-4:medium",
		};

		registerModeHooks(mock.pi as never, state);

		await mock.fire("model_select", { source: "set", model: {}, previousModel: {} }, {
			modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined },
			model: undefined,
		});

		expect(mock.pi.setModel).not.toHaveBeenCalled();
	});

	it("records a user model pick from model_select set and persists", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "kuafu";
		registerModeHooks(mock.pi as never, state);

		await mock.fire("model_select", { source: "set", model: { provider: "openai", id: "gpt-4o" }, previousModel: {} }, {
			modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined },
			model: undefined,
		});

		expect(state.modelOverride).toBe("openai/gpt-4o");
		expect(mock.pi.appendEntry).toHaveBeenCalledWith(
			"agent-mode",
			expect.objectContaining({ modelOverride: "openai/gpt-4o" }),
		);
	});

	it("does not record a model pick while applyingModelConfig is set", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "kuafu";
		state.applyingModelConfig = true;
		registerModeHooks(mock.pi as never, state);

		await mock.fire("model_select", { source: "set", model: { provider: "openai", id: "gpt-4o" }, previousModel: {} }, {
			modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined },
			model: undefined,
		});

		expect(state.modelOverride).toBeUndefined();
		expect(mock.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("does not re-persist when model_select repeats the current override", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "kuafu";
		state.modelOverride = "openai/gpt-4o";
		registerModeHooks(mock.pi as never, state);

		await mock.fire("model_select", { source: "set", model: { provider: "openai", id: "gpt-4o" }, previousModel: {} }, {
			modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined },
			model: undefined,
		});

		expect(state.modelOverride).toBe("openai/gpt-4o");
		expect(mock.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("records a user effort pick from thinking_level_select and persists", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		registerModeHooks(mock.pi as never, state);

		await mock.fire("thinking_level_select", { level: "high", previousLevel: "off" }, {});

		expect(state.thinkingOverride).toBe("high");
		expect(mock.pi.appendEntry).toHaveBeenCalledWith(
			"agent-mode",
			expect.objectContaining({ thinkingOverride: "high" }),
		);
	});

	it("ignores thinking_level_select while applyingModelConfig is set", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.applyingModelConfig = true;
		registerModeHooks(mock.pi as never, state);

		await mock.fire("thinking_level_select", { level: "high", previousLevel: "off" }, {});

		expect(state.thinkingOverride).toBeUndefined();
		expect(mock.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("ignores thinking_level_select that echoes the mode-applied level", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.appliedThinkingLevel = "high";
		registerModeHooks(mock.pi as never, state);

		await mock.fire("thinking_level_select", { level: "high", previousLevel: "off" }, {});

		expect(state.thinkingOverride).toBeUndefined();
		expect(mock.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("uses gpt variant body when resolvedFamily is gpt", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "kuafu";
		state.cachedConfigs["kuafu:gpt"] = { body: "GPT variant body", toolRules: [] };
		state.cachedConfigs["kuafu:default"] = { body: "default body", toolRules: [] };
		state.resolvedFamily = "gpt";

		registerModeHooks(mock.pi as never, state);

		const event = beforeAgentStartEvent("Base");
		const [result] = await mock.fire("before_agent_start", event, { hasUI: false });
		expect(result).toBeUndefined();
		expect(event.systemPromptOptions.sections.modes).toBe("GPT variant body");
	});

	it("injects gemini overlays before <critical> when resolvedFamily is gemini", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "kuafu";
		state.cachedConfigs["kuafu:gemini"] = {
			body: "before\n\n<critical>\nafter",
			toolRules: [],
			overlays: "<GEMINI_INTENT_GATE>must classify</GEMINI_INTENT_GATE>",
		};
		state.cachedConfigs["kuafu:default"] = { body: "before\n\n<critical>\nafter", toolRules: [] };
		state.resolvedFamily = "gemini";

		registerModeHooks(mock.pi as never, state);

		const event = beforeAgentStartEvent("");
		const [result] = await mock.fire("before_agent_start", event, { hasUI: false });
		expect(result).toBeUndefined();
		const sp = event.systemPromptOptions.sections.modes ?? "";
		expect(sp).toContain("<GEMINI_INTENT_GATE>must classify</GEMINI_INTENT_GATE>");
		const overlayPos = sp.indexOf("<GEMINI_INTENT_GATE>");
		const criticalPos = sp.indexOf("<critical>");
		expect(overlayPos).toBeLessThan(criticalPos);
	});

	it("injects gemini overlays after </role> when no <critical> anchor exists", async () => {
		const overlay = "<GEMINI_ROLE_FALLBACK>after role</GEMINI_ROLE_FALLBACK>";
		const prompt = (await renderInjectedPrompt({
			mode: "kuafu",
			family: "gemini",
			defaultConfig: { body: "<role>\nRole only\n</role>\n\nBody" },
			familyConfig: {
				body: "<role>\nRole only\n</role>\n\nBody",
				overlays: overlay,
			},
		})) ?? "";

		expect(prompt.indexOf(overlay)).toBeGreaterThan(prompt.indexOf("</role>"));
		expect(prompt.indexOf(overlay)).toBeLessThan(prompt.indexOf("Body"));
	});

	it("appends gemini overlays when no <critical> or </role> anchors exist", async () => {
		const overlay = "<GEMINI_APPEND_FALLBACK>append</GEMINI_APPEND_FALLBACK>";
		const prompt = (await renderInjectedPrompt({
			mode: "kuafu",
			family: "gemini",
			defaultConfig: { body: "Plain body" },
			familyConfig: { body: "Plain body", overlays: overlay },
		})) ?? "";

		expect(prompt.indexOf(overlay)).toBeGreaterThan(prompt.indexOf("Plain body"));
		expect(prompt.endsWith(overlay)).toBe(true);
	});
});

describe("mode runtime model fallback", () => {
	it("uses the active override chain and applies its candidate defaults once", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.cachedConfigs["kuafu:default"] = {
			body: "build",
			toolRules: [],
			model: "anthropic/configured-primary,anthropic/configured-fallback",
		};
		state.modelOverride = "anthropic/active-primary,openai-codex/gpt-5.4:high:fast";
		const current = { provider: "anthropic", id: "active-primary", api: "anthropic-messages" };
		const fallback = { provider: "openai-codex", id: "gpt-5.4", api: "openai-codex-responses" };
		const ctx = {
			model: current,
			modelRegistry: {
				getAll: () => [current, fallback],
				getAvailable: () => [current, fallback],
				find: (provider: string, id: string) => [current, fallback].find((model) => model.provider === provider && model.id === id),
				isUsingOAuth: () => true,
			},
			sessionManager: { getBranch: () => [], getSessionId: () => "main-mode-session" },
		};
		registerModeHooks(mock.pi as never, state);

		await mock.fire("message_end", { message: { role: "assistant", stopReason: "error", status: 429 } }, ctx);
		await mock.fire("agent_settled", {}, ctx);

		expect(mock.pi.setModel).toHaveBeenCalledWith(fallback);
		expect(mock.pi.setThinkingLevel).toHaveBeenCalledTimes(1);
		expect(mock.pi.setThinkingLevel).toHaveBeenCalledWith("high");
		expect(mock.pi.appendEntry).toHaveBeenCalledWith("fast-policy", { version: 1, mode: "kuafu", source: "mode", enabled: true });
		expect(mock.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "runtime-model-fallback", display: false }), { triggerTurn: true });
	});

	it.each([
		["without a configured chain", undefined, undefined],
		["for a subagent session", "anthropic/active-primary,openai-codex/gpt-5.4", "/tmp/subagent-sessions/child.jsonl"],
	])("does not recover %s", async (_reason: string, chain: string | undefined, sessionFile: string | undefined) => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.cachedConfigs["kuafu:default"] = { body: "build", model: chain, toolRules: [] };
		const current = { provider: "anthropic", id: "active-primary", api: "anthropic-messages" };
		const fallback = { provider: "openai-codex", id: "gpt-5.4", api: "openai-codex-responses" };
		const ctx = {
			model: current,
			modelRegistry: {
				getAll: () => [current, fallback],
				getAvailable: () => [current, fallback],
				find: (provider: string, id: string) => [current, fallback].find((model) => model.provider === provider && model.id === id),
				isUsingOAuth: () => true,
			},
			sessionManager: { getBranch: () => [], getSessionId: () => "mode-session", getSessionFile: () => sessionFile },
		};
		registerModeHooks(mock.pi as never, state);

		await mock.fire("message_end", { message: { role: "assistant", stopReason: "error", status: 429 } }, ctx);
		await mock.fire("agent_settled", {}, ctx);

		expect(mock.pi.setModel).not.toHaveBeenCalled();
		expect(mock.pi.sendMessage).not.toHaveBeenCalled();
	});

	it("rejects unsupported Fast before switching or persisting policy", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.cachedConfigs["kuafu:default"] = { body: "build", model: "anthropic/active-primary,openai-codex/gpt-5.4:fast", toolRules: [] };
		const current = { provider: "anthropic", id: "active-primary", api: "anthropic-messages" };
		const fallback = { provider: "openai-codex", id: "gpt-5.4", api: "openai-codex-responses" };
		const ctx = {
			model: current,
			modelRegistry: {
				getAll: () => [current, fallback],
				getAvailable: () => [current, fallback],
				find: (provider: string, id: string) => [current, fallback].find((model) => model.provider === provider && model.id === id),
				isUsingOAuth: () => false,
			},
			sessionManager: { getBranch: () => [], getSessionId: () => "mode-session" },
		};
		registerModeHooks(mock.pi as never, state);

		await mock.fire("message_end", { message: { role: "assistant", stopReason: "error", status: 429 } }, ctx);
		await expect(mock.fire("agent_settled", {}, ctx)).rejects.toThrow(/Explicit :fast is unsupported/);

		expect(mock.pi.setModel).not.toHaveBeenCalled();
		expect(mock.pi.appendEntry).not.toHaveBeenCalledWith("fast-policy", expect.anything());
		expect(mock.pi.sendMessage).not.toHaveBeenCalled();
	});
});

describe("mode tool ceiling", () => {
	const SUBAGENT_SESSION = "/tmp/subagent-sessions/child.jsonl";

	function setup(rules: string, tools: MockTool[] = [{ name: "read" }, { name: "edit" }]) {
		const mock = createMockPi(tools);
		const state = new ModeStateManager(mock.pi as never);
		state.cachedConfigs["kuafu:default"] = { body: "", toolRules: toolRules(rules) };
		registerModeHooks(mock.pi as never, state);
		return mock;
	}

	function ceilingRegistrations(mock: ReturnType<typeof createMockPi>): number {
		return mock.pi.registerTool.mock.calls.filter(([definition]: [MockToolDefinition]) => definition.name === MODE_TOOL_CEILING_NAME).length;
	}

	it("registers the ceiling once across main-session starts", async () => {
		const mock = setup("+read");

		await mock.fire("session_start", {}, createSessionCtx());
		await mock.fire("session_start", {}, createSessionCtx());

		expect(ceilingRegistrations(mock)).toBe(1);
	});

	it("does not register the ceiling in a subagent session", async () => {
		const mock = setup("+read");

		await mock.fire("session_start", {}, createSessionCtx(SUBAGENT_SESSION));

		expect(ceilingRegistrations(mock)).toBe(0);
	});

	it("hides its own declaration and every declared ungranted tool", async () => {
		const mock = setup("+read");
		await mock.fire("session_start", {}, createSessionCtx());

		mock.pi.setActiveTools([...mock.pi.getActiveTools(), "edit"]);

		expect(mock.hiddenDeclarations()).toEqual(["edit", MODE_TOOL_CEILING_NAME].sort());
	});

	it("hides a loader registered late and re-added by a handler that runs after modes", async () => {
		const mock = setup("+read", [{ name: "read" }]);
		mock.pi.on("before_agent_start", async () => {
			mock.pi.setActiveTools([...mock.pi.getActiveTools().filter((name) => name !== "web_enable"), "web_enable"]);
		});
		await mock.fire("session_start", {}, createSessionCtx());
		mock.addTool({ name: "web_enable", sourceInfo: { path: "/fixture/pi-web-access/index.ts" } });

		await mock.fire("before_agent_start", beforeAgentStartEvent("Base"), createSessionCtx());

		expect(mock.hiddenDeclarations()).toContain("web_enable");
	});

	it("re-adds the ceiling at turn end after another extension dropped it", async () => {
		const mock = setup("+read");
		await mock.fire("session_start", {}, createSessionCtx());
		mock.pi.setActiveTools(["read"]);

		await mock.fire("turn_end", {}, createSessionCtx());

		expect(mock.pi.getActiveTools()).toEqual(["read", MODE_TOOL_CEILING_NAME]);
	});

	it("leaves active tools alone at turn end while the ceiling is active", async () => {
		const mock = setup("+read");
		await mock.fire("session_start", {}, createSessionCtx());
		mock.pi.setActiveTools.mockClear();

		await mock.fire("turn_end", {}, createSessionCtx());

		expect(mock.pi.setActiveTools).not.toHaveBeenCalled();
	});
});

describe("mode tool_call veto", () => {
	const GOAL_ACCESS = [{ type: "custom", customType: "pi-goal-access", data: { sessionId: "fixture" } }];

	function setup(mode: TestMode = "kuafu", sessionFile?: string) {
		const mock = createMockPi([
			{ name: "read" },
			{ name: "secret_tool" },
			{ name: "create_goal", exposure: "deferred" },
			{ name: "plan_approve" },
		]);
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = mode;
		state.cachedConfigs[`${mode}:default`] = { body: "", toolRules: toolRules("+read, +create_goal, +plan_approve") };
		registerModeHooks(mock.pi as never, state);
		return async (toolName: string, options: { parentToolCallId?: string; entries?: unknown[] } = {}) => (await mock.fire(
			"tool_call",
			{
				type: "tool_call",
				toolCallId: options.parentToolCallId ? `${options.parentToolCallId}/1` : "call-1",
				parentToolCallId: options.parentToolCallId,
				toolName,
				input: {},
			},
			createSessionCtx(sessionFile, options.entries),
		))[0];
	}

	it("blocks an ungranted top-level call", async () => {
		const call = setup();

		await expect(call("secret_tool")).resolves.toEqual({ block: true, reason: 'Mode kuafu: tool "secret_tool" is not available.' });
	});

	it("blocks an ungranted nested call", async () => {
		const call = setup();

		await expect(call("secret_tool", { parentToolCallId: "parent" })).resolves.toEqual({
			block: true,
			reason: 'Mode kuafu: tool "secret_tool" is not available.',
		});
	});

	it("allows a granted call", async () => {
		const call = setup();

		await expect(call("read")).resolves.toBeUndefined();
	});

	it.each([
		["kuafu", { block: true, reason: 'Mode kuafu: tool "plan_approve" is not available.' }],
		["fuxi", undefined],
	] as const)("allows a granted Fu Xi plan tool only in fuxi (%s)", async (mode: TestMode, expected: unknown) => {
		const call = setup(mode);

		await expect(call("plan_approve", { parentToolCallId: "parent" })).resolves.toEqual(expected);
	});

	it("leaves subagent sessions to their own frontmatter scope", async () => {
		const call = setup("kuafu", "/tmp/subagent-sessions/child.jsonl");

		await expect(call("secret_tool")).resolves.toBeUndefined();
	});

	it("checks a Goal tool call against fresh Goal access", async () => {
		const call = setup();

		await expect(call("create_goal", { entries: GOAL_ACCESS })).resolves.toBeUndefined();
	});
});
