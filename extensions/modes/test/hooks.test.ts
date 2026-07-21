import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	CustomEditor: class {
		constructor(..._args: unknown[]) {}
		handleInput(_data: string): void {}
		getText(): string {
			return "";
		}
	},
}));

vi.mock("@earendil-works/pi-tui", () => ({
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

const ALL_TEST_MODES: TestMode[] = ["kuafu", "fuxi", "houtu", "luban", "shennong"];

const MODE_PROMPT_FILES: Record<PromptFamily, string> = {
	default: "mode.md",
	gpt: "gpt.md",
	gemini: "gemini.md",
};

type PromptInvariantSet = {
	default: string[];
	gpt: string[];
	geminiOverlay: string[];
	defaultOnlyInGptReplacement: string;
	overlayAnchor: string;
};

const MODE_PROMPT_INVARIANTS: Record<TestMode, PromptInvariantSet> = {
	kuafu: {
		default: ["Implementation authorization gate", "Orchestrate first", "No evidence = not complete"],
		gpt: ["Implementation authorization gate", "codegraph_*", "Subagent self-report is never evidence"],
		geminiOverlay: ["<KUAFU_INTENT_GATE>", "<KUAFU_VERIFICATION_OVERRIDE>"],
		defaultOnlyInGptReplacement: "Turn-local intent gate controls every response.",
		overlayAnchor: "<KUAFU_INTENT_GATE>",
	},
	fuxi: {
		default: [
			"Plan only. MUST NOT implement",
			"Plan mode is sticky",
			"separate worker session that only the user starts",
			"ulw-plan",
			"Load the `ulw-plan` skill before planning",
			"MUST NOT restate or inline the planning workflow",
			"local://DRAFT.md",
			"local://PLAN.md",
			"plan_approve",
		],
		gpt: [
			"Plan only. MUST NOT implement",
			"Plan mode is sticky",
			"separate worker session that only the user starts",
			"ulw-plan",
			"Load the `ulw-plan` skill before planning",
			"MUST NOT restate or inline the planning workflow",
			"local://DRAFT.md",
			"local://PLAN.md",
			"plan_approve",
		],
		geminiOverlay: [
			"<FUXI_INTENT_GATE>",
			"<FUXI_APPROVAL_GATE>",
			"<FUXI_VERIFICATION_OVERRIDE>",
		],
		defaultOnlyInGptReplacement: "MANDATORY PLAN GENERATION SEQUENCE",
		overlayAnchor: "<FUXI_INTENT_GATE>",
	},
	houtu: {
		default: [
			"You execute by coordinating, delegating, and verifying",
			"Pi-tasks track plan identity, dependencies, and verified status only",
			"Delegate all plan work directly with `Agent`",
			"Use pi-tasks for logical tracking; use Agent/get_subagent_result/steer_subagent for agent lifecycle",
			"Final Verification Wave gate",
		],
		gpt: [
			"Read `PLAN.md` before doing anything else",
			"buildPlanExecutionGoal(planPath)",
			"Pi-tasks: `TaskCreate` one task per top-level PLAN item",
			"Agent lifecycle: launch plan work with `Agent`",
			"Use pi-tasks for logical tracking; use Agent/get_subagent_result/steer_subagent for agent lifecycle",
			"Final Verification Wave is a mandatory approval gate",
			"APPROVE",
		],
		geminiOverlay: ["<gemini-corrective-overlay>", "Hou Tu coordinates only", "Pi-tasks track logical PLAN work only", "Delegate one bounded plan task per `Agent` session", "every Final Verification Wave gate has explicit `APPROVE`"],
		defaultOnlyInGptReplacement: "<tracking_contract>",
		overlayAnchor: "<gemini-corrective-overlay>",
	},
	luban: {
		default: [
			"Skill-first is mandatory",
			"Do not claim Sisyphus, Prometheus, Atlas, or upstream agent-profile parity",
			"Parallelism is safety-gated, not maximized",
		],
		gpt: [
			"Before any response or action, run the skill gate",
			"1% chance a skill applies",
			"Do not claim Sisyphus, Prometheus, Atlas",
			"verification-before-completion",
		],
		geminiOverlay: ["<LUBAN_GEMINI_CORRECTIVE_OVERLAY>", "Do not skip skill loading", "verify with readback"],
		defaultOnlyInGptReplacement: "Consult the grain before the first cut",
		overlayAnchor: "<LUBAN_GEMINI_CORRECTIVE_OVERLAY>",
	},
	shennong: {
		default: ["No code, no implementation plans, no patching.", "Prioritization by LNO only", "Decision already made -> `/pm:write-prd` in place."],
		gpt: ["PM-mode strategist for Pi decisions.", "One Leverage action max for next move", "Hand off with `/mode kuafu`."],
		geminiOverlay: ["<SHENNONG_GEMINI_CORRECTIVE_OVERLAY>", "Use Shen Nong base behavior with strict PM correction:"],
		defaultOnlyInGptReplacement: "You think in Shreyas-style PM mode:",
		overlayAnchor: "<SHENNONG_GEMINI_CORRECTIVE_OVERLAY>",
	},
};

function getModePromptPath(mode: TestMode, family: PromptFamily): string {
	return join(process.cwd(), "modes", mode, MODE_PROMPT_FILES[family]);
}

function stripFrontmatter(markdown: string): string {
	return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

function readModePromptBody(mode: TestMode, family: PromptFamily): string {
	const content = readFileSync(getModePromptPath(mode, family), "utf-8");
	return family === "default" ? stripFrontmatter(content) : content.trim();
}

function expectContainsAll(text: string, expectedSnippets: string[]): void {
	for (const snippet of expectedSnippets) {
		expect(text).toContain(snippet);
	}
}

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

	it("instructs Fu Xi to load the discovered ulw-plan skill in every prompt family", async () => {
		const defaultBody = readModePromptBody("fuxi", "default");
		const gptBody = readModePromptBody("fuxi", "gpt");
		const geminiOverlay = readModePromptBody("fuxi", "gemini");
		const prompts = [
			await renderInjectedPrompt({ mode: "fuxi", defaultConfig: { body: defaultBody } }),
			await renderInjectedPrompt({
				mode: "fuxi",
				family: "gpt",
				defaultConfig: { body: defaultBody },
				familyConfig: { body: gptBody },
			}),
			await renderInjectedPrompt({
				mode: "fuxi",
				family: "gemini",
				defaultConfig: { body: defaultBody },
				familyConfig: { body: defaultBody, overlays: geminiOverlay },
			}),
		];

		for (const prompt of prompts) {
			expect(prompt).toContain("Load the `ulw-plan` skill before planning");
		}
	});

	it("keeps Hou Tu implementation foreground while exploration remains background", async () => {
		const defaultBody = readModePromptBody("houtu", "default");
		const gptBody = readModePromptBody("houtu", "gpt");
		const geminiOverlay = readModePromptBody("houtu", "gemini");
		const prompts = [
			await renderInjectedPrompt({ mode: "houtu", defaultConfig: { body: defaultBody } }),
			await renderInjectedPrompt({
				mode: "houtu",
				family: "gpt",
				defaultConfig: { body: defaultBody },
				familyConfig: { body: gptBody },
			}),
			await renderInjectedPrompt({
				mode: "houtu",
				family: "gemini",
				defaultConfig: { body: defaultBody },
				familyConfig: { body: defaultBody, overlays: geminiOverlay },
			}),
		];

		for (const prompt of prompts) {
			expect(prompt).toContain("2. **Wait for the completion notification** - the system will trigger your next turn");
			expect(prompt).toContain("3. **Then** collect results via `get_subagent_result(agent_id=\"...\")`");
			expect(prompt).toContain("**Exploration** (`chengfeng`, `wenchang`): `run_in_background=true` — non-blocking research");
			expect(prompt).toContain("**Task execution** (`Agent(...)`): `run_in_background=false` — blocks for verification");
			expect(prompt).toContain("**Background management:**");
			expect(prompt).toContain("Collect with background agent IDs: `get_subagent_result(agent_id=\"...\")`");
			expect(prompt).toContain("Continue follow-ups with agent IDs: `Agent(resume=\"...\")`");
			const foregroundRuns = prompt.match(/run_in_background(?:\s*:\s*|=)false/g) ?? [];
			expect(foregroundRuns.length).toBeGreaterThanOrEqual(4);
			expect(prompt).not.toContain("Stop the dependent work");
			expect(prompt).not.toContain("Use background for exploration AND for every parallel implementation batch");
			expect(prompt).not.toContain("Launch independent, conflict-free tasks as separate background agents");
		}
	});

	it("renders actual default, GPT, and Gemini final prompts for every mode", async () => {
		for (const mode of ALL_TEST_MODES) {
			const invariants = MODE_PROMPT_INVARIANTS[mode];
			const defaultBody = readModePromptBody(mode, "default");
			const gptBody = readModePromptBody(mode, "gpt");
			const geminiOverlay = readModePromptBody(mode, "gemini");
			const stalePrompt = "Base\n\n<!-- mode:fuxi -->\nstale plan prompt\n<!-- /mode:fuxi -->";

			const defaultPrompt = await renderInjectedPrompt({
				mode,
				family: "default",
				basePrompt: stalePrompt,
				defaultConfig: { body: defaultBody, promptMode: "replace" },
			});
			expect(defaultPrompt).toContain(`<!-- mode:${mode} -->`);
			expect(defaultPrompt).not.toContain("stale plan prompt");
			expectContainsAll(defaultPrompt, invariants.default);

			const gptPrompt = await renderInjectedPrompt({
				mode,
				family: "gpt",
				basePrompt: stalePrompt,
				defaultConfig: { body: defaultBody, promptMode: "replace" },
				familyConfig: { body: gptBody, promptMode: "replace" },
			});
			expect(gptPrompt).toContain(`<!-- mode:${mode} -->`);
			expect(gptPrompt).not.toContain("stale plan prompt");
			expectContainsAll(gptPrompt, invariants.gpt);
			expect(gptPrompt).not.toContain(invariants.defaultOnlyInGptReplacement);

			const geminiPrompt = await renderInjectedPrompt({
				mode,
				family: "gemini",
				basePrompt: stalePrompt,
				defaultConfig: { body: defaultBody, promptMode: "replace" },
				familyConfig: { body: defaultBody, overlays: geminiOverlay, promptMode: "replace" },
			});
			expect(geminiPrompt).toContain(`<!-- mode:${mode} -->`);
			expect(geminiPrompt).not.toContain("stale plan prompt");
			expectContainsAll(geminiPrompt, invariants.default);
			expectContainsAll(geminiPrompt, invariants.geminiOverlay);

			const overlayPos = geminiPrompt.indexOf(invariants.overlayAnchor);
			expect(overlayPos).toBeGreaterThan(-1);
			if (defaultBody.includes("<critical>")) {
				const criticalPos = geminiPrompt.indexOf("<critical>");
				expect(criticalPos).toBeGreaterThan(-1);
				expect(overlayPos).toBeLessThan(criticalPos);
			} else {
				expect(geminiPrompt).toContain("</role>");
				expect(overlayPos).toBeGreaterThan(geminiPrompt.indexOf("</role>"));
			}
		}
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

	it("blocks built-in bash commands in plan mode", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "fuxi";
		state.cachedConfigs["fuxi:default"] = { body: "" };

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
