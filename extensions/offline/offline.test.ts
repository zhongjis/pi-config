import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import offlineExtension, { loadOfflineConfig, OFFLINE_SYSTEM_PROMPT } from "./index.js";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

type MockModel = { id: string; name: string; provider: string };

const cloudModel: MockModel = { id: "claude-sonnet", name: "Claude", provider: "anthropic" };
const defaultLocalModel: MockModel = { id: "qwen3.6:27b", name: "Qwen", provider: "llama-swap" };
const coderLocalModel: MockModel = { id: "qwen2.5-coder:7b", name: "Coder", provider: "llama-swap" };

function createMockRegistry(models: MockModel[]) {
	return {
		find: vi.fn((provider: string, modelId: string) => models.find((model) => model.provider === provider && model.id === modelId)),
		getAll: vi.fn(() => models),
		getAvailable: vi.fn(() => models),
	};
}

function createHarness() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const flags = new Map<string, unknown>();
	const pi = {
		getFlag: vi.fn((name: string) => flags.get(name)),
		registerFlag: vi.fn((name: string, definition: unknown) => flags.set(name, definition)),
		registerCommand: vi.fn((name: string, definition: any) => commands.set(name, definition)),
		on: vi.fn((event: string, handler: Handler) => {
			const next = handlers.get(event) ?? [];
			next.push(handler);
			handlers.set(event, next);
		}),
		setModel: vi.fn(async () => true),
	};
	offlineExtension(pi as never);
	return {
		commands,
		flags,
		pi,
		async fire(event: string, payload: any, ctx: any) {
			const results = [];
			for (const handler of handlers.get(event) ?? []) {
				results.push(await handler(payload, ctx));
			}
			return results;
		},
	};
}

function createContext(cwd: string, model: MockModel | undefined = cloudModel) {
	return {
		cwd,
		hasUI: true,
		model,
		modelRegistry: createMockRegistry([cloudModel, defaultLocalModel, coderLocalModel]),
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
		},
	};
}

let tempHome = "";
let tempProject = "";
let originalHome: string | undefined;
let originalOfflineEnv: string | undefined;

beforeEach(async () => {
	originalHome = process.env.HOME;
	originalOfflineEnv = process.env.PI_AGENT_OFFLINE_MODE;
	tempHome = join(tmpdir(), `offline-home-${Date.now()}-${Math.random()}`);
	tempProject = join(tmpdir(), `offline-project-${Date.now()}-${Math.random()}`);
	await mkdir(tempHome, { recursive: true });
	await mkdir(tempProject, { recursive: true });
	process.env.HOME = tempHome;
	delete process.env.PI_AGENT_OFFLINE_MODE;
});

afterEach(async () => {
	process.env.HOME = originalHome;
	if (originalOfflineEnv === undefined) {
		delete process.env.PI_AGENT_OFFLINE_MODE;
	} else {
		process.env.PI_AGENT_OFFLINE_MODE = originalOfflineEnv;
	}
	vi.restoreAllMocks();
	await rm(tempHome, { force: true, recursive: true });
	await rm(tempProject, { force: true, recursive: true });
});

describe("offline config", () => {
	it("merges defaults, global config, then project config", async () => {
		await mkdir(join(tempHome, ".pi", "agent"), { recursive: true });
		await mkdir(join(tempProject, ".pi"), { recursive: true });
		await writeFile(join(tempHome, ".pi", "agent", "offline.json"), JSON.stringify({
			enabled: true,
			localProviders: ["global-local"],
			blockedTools: ["global_tool"],
			agentModels: { extra: "global-model", jintong: "global-jintong" },
		}));
		await writeFile(join(tempProject, ".pi", "offline.json"), JSON.stringify({
			localProviders: ["project-local"],
			statusText: "offline: project",
			agentModels: { jintong: "project-jintong" },
		}));

		const config = loadOfflineConfig(tempProject);

		expect(config.enabled).toBe(true);
		expect(config.localProviders).toEqual(["project-local"]);
		expect(config.blockedTools).toEqual(["global_tool"]);
		expect(config.statusText).toBe("offline: project");
		expect(config.agentModels.extra).toBe("global-model");
		expect(config.agentModels.jintong).toBe("project-jintong");
	});
});

describe("offline activation", () => {
	it("lets /offline off override config, flag, and env for the current session", async () => {
		await mkdir(join(tempProject, ".pi"), { recursive: true });
		await writeFile(join(tempProject, ".pi", "offline.json"), JSON.stringify({ enabled: true }));
		process.env.PI_AGENT_OFFLINE_MODE = "1";
		const harness = createHarness();
		harness.pi.getFlag.mockImplementation((name: string) => name === "offline-mode" ? true : undefined);
		const ctx = createContext(tempProject);

		await harness.fire("session_start", {}, ctx);
		await harness.commands.get("offline")?.handler("off", ctx);
		const [result] = await harness.fire("before_agent_start", { systemPrompt: "Base" }, ctx);

		expect(result).toBeUndefined();
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("offline", undefined);
	});

	it("filters modelRegistry.getAvailable to local providers while active", async () => {
		await mkdir(join(tempProject, ".pi"), { recursive: true });
		await writeFile(join(tempProject, ".pi", "offline.json"), JSON.stringify({ enabled: true }));
		const harness = createHarness();
		const ctx = createContext(tempProject);

		await harness.fire("session_start", {}, ctx);

		expect(ctx.modelRegistry.getAvailable()).toEqual([defaultLocalModel, coderLocalModel]);

		await harness.commands.get("offline")?.handler("off", ctx);
		expect(ctx.modelRegistry.getAvailable()).toEqual([cloudModel, defaultLocalModel, coderLocalModel]);
	});

	it("forces the parent model when the current model is cloud", async () => {
		await mkdir(join(tempProject, ".pi"), { recursive: true });
		await writeFile(join(tempProject, ".pi", "offline.json"), JSON.stringify({ enabled: true }));
		const harness = createHarness();
		const ctx = createContext(tempProject, cloudModel);

		await harness.fire("session_start", {}, ctx);

		expect(harness.pi.setModel).toHaveBeenCalledWith(defaultLocalModel);
	});

	it("enables offline mode from /offline on when config is disabled", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject);

		await harness.commands.get("offline")?.handler("on", ctx);
		const [result] = await harness.fire("before_agent_start", { systemPrompt: "Base" }, ctx) as [{ systemPrompt: string }];

		expect(result.systemPrompt).toContain(OFFLINE_SYSTEM_PROMPT);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("offline", "offline: llama-swap");
	});
});

describe("offline guards", () => {
	it("injects offline instructions only when active", async () => {
		const inactiveHarness = createHarness();
		const inactiveCtx = createContext(tempProject);
		const [inactiveResult] = await inactiveHarness.fire("before_agent_start", { systemPrompt: "Base" }, inactiveCtx);
		expect(inactiveResult).toBeUndefined();

		process.env.PI_AGENT_OFFLINE_MODE = "1";
		const activeHarness = createHarness();
		const activeCtx = createContext(tempProject);
		const [activeResult] = await activeHarness.fire("before_agent_start", { systemPrompt: "Base" }, activeCtx) as [{ systemPrompt: string }];

		expect(activeResult.systemPrompt).toContain("Base");
		expect(activeResult.systemPrompt).toContain(OFFLINE_SYSTEM_PROMPT);
	});

	it("blocks web tools and wenchang delegation", async () => {
		process.env.PI_AGENT_OFFLINE_MODE = "1";
		const harness = createHarness();
		const ctx = createContext(tempProject);

		const [webResult] = await harness.fire("tool_call", { type: "tool_call", toolCallId: "web", toolName: "web_search", input: {} }, ctx);
		const [agentResult] = await harness.fire("tool_call", { type: "tool_call", toolCallId: "agent", toolName: "Agent", input: { subagent_type: "wenchang" } }, ctx);

		expect(webResult).toMatchObject({ block: true, reason: expect.stringContaining("web_search") });
		expect(agentResult).toMatchObject({ block: true, reason: expect.stringContaining("wenchang") });
	});

	it("temporarily switches and restores the parent model for configured Agent calls", async () => {
		process.env.PI_AGENT_OFFLINE_MODE = "1";
		const harness = createHarness();
		const ctx = createContext(tempProject, defaultLocalModel);

		await harness.fire("tool_call", { type: "tool_call", toolCallId: "agent-1", toolName: "Agent", input: { subagent_type: "chengfeng" } }, ctx);
		expect(harness.pi.setModel).toHaveBeenLastCalledWith(coderLocalModel);

		ctx.model = coderLocalModel;
		await harness.fire("tool_result", { type: "tool_result", toolCallId: "agent-1", toolName: "Agent", input: {}, content: [], isError: false }, ctx);

		expect(harness.pi.setModel).toHaveBeenLastCalledWith(defaultLocalModel);
	});

	it("shows the session-start notification once and not on every turn", async () => {
		process.env.PI_AGENT_OFFLINE_MODE = "1";
		const harness = createHarness();
		const ctx = createContext(tempProject);

		await harness.fire("session_start", {}, ctx);
		await harness.fire("before_agent_start", { systemPrompt: "Base" }, ctx);
		await harness.fire("before_agent_start", { systemPrompt: "Base" }, ctx);

		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Offline mode enabled: local models only; web tools and wenchang disabled.",
			"info",
		);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("offline", "offline: llama-swap");
	});
});
