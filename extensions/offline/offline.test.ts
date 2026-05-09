import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFirstAvailable, resolveModel } from "../lib/model.js";
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
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const pi = {
		appendEntry: vi.fn((customType: string, data: unknown) => {
			appendedEntries.push({ customType, data });
		}),
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
		appendedEntries,
		commands,
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

function createContext(
	cwd: string,
	model: MockModel | undefined = cloudModel,
	entries: Array<{ type: string; customType?: string; data?: unknown }> = [],
	registry = createMockRegistry([cloudModel, defaultLocalModel, coderLocalModel]),
) {
	return {
		cwd,
		hasUI: true,
		model,
		modelRegistry: registry,
		sessionManager: {
			getEntries: vi.fn(() => entries),
		},
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
		},
	};
}

let tempHome = "";
let tempProject = "";
let originalHome: string | undefined;

beforeEach(async () => {
	originalHome = process.env.HOME;
	tempHome = join(tmpdir(), `offline-home-${Date.now()}-${Math.random()}`);
	tempProject = join(tmpdir(), `offline-project-${Date.now()}-${Math.random()}`);
	await mkdir(tempHome, { recursive: true });
	await mkdir(tempProject, { recursive: true });
	delete process.env.PI_AGENT_OFFLINE_MODE;
});

afterEach(async () => {
	process.env.HOME = originalHome;
	vi.restoreAllMocks();
	await rm(tempHome, { force: true, recursive: true });
	await rm(tempProject, { force: true, recursive: true });
});

describe("offline config", () => {
	it("loads project policy without reading global config or activation", async () => {
		await mkdir(join(tempHome, ".pi", "agent"), { recursive: true });
		await mkdir(join(tempProject, ".pi"), { recursive: true });
		await writeFile(join(tempHome, ".pi", "agent", "offline.json"), JSON.stringify({
			localProviders: ["global-local"],
			blockedTools: ["global_tool"],
		}));
		await writeFile(join(tempProject, ".pi", "offline.json"), JSON.stringify({
			enabled: true,
			localProviders: ["project-local"],
			statusText: "offline: project",
			agentModels: { jintong: "project-jintong" },
		}));

		const config = loadOfflineConfig(tempProject);

		expect(config.localProviders).toEqual(["project-local"]);
		expect(config.blockedTools).toEqual(["web_search", "code_search", "fetch_content", "get_search_content"]);
		expect(config.statusText).toBe("offline: project");
		expect(config).not.toHaveProperty("enabled");
		expect(config).not.toHaveProperty("agentModels");
	});
});

describe("offline activation", () => {
	it("starts inactive when the session has no offline entry", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject);

		await harness.fire("session_start", {}, ctx);
		const [result] = await harness.fire("before_agent_start", { systemPrompt: "Base" }, ctx);

		expect(result).toBeUndefined();
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("offline", undefined);
		expect(harness.pi.setModel).not.toHaveBeenCalled();
	});

	it("restores active state from the latest session entry", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject, cloudModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: false } },
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);

		await harness.fire("session_start", {}, ctx);
		const [result] = await harness.fire("before_agent_start", { systemPrompt: "Base" }, ctx) as [{ systemPrompt: string }];

		expect(result.systemPrompt).toContain(OFFLINE_SYSTEM_PROMPT);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("offline", "offline: llama-swap");
		expect(harness.pi.setModel).toHaveBeenCalledWith(defaultLocalModel);
	});

	it("/offline on appends active session state and enables guards", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject);

		await harness.commands.get("offline")?.handler("on", ctx);
		const [result] = await harness.fire("before_agent_start", { systemPrompt: "Base" }, ctx) as [{ systemPrompt: string }];

		expect(harness.appendedEntries).toEqual([{ customType: "panda:offline-mode", data: { active: true } }]);
		expect(result.systemPrompt).toContain(OFFLINE_SYSTEM_PROMPT);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("offline", "offline: llama-swap");
	});

	it("/offline off appends inactive session state and disables own guards", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);

		await harness.fire("session_start", {}, ctx);
		await harness.commands.get("offline")?.handler("off", ctx);
		const [result] = await harness.fire("before_agent_start", { systemPrompt: "Base" }, ctx);

		expect(harness.appendedEntries).toEqual([{ customType: "panda:offline-mode", data: { active: false } }]);
		expect(result).toBeUndefined();
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("offline", undefined);
	});
});

describe("offline guards", () => {
	it("injects offline instructions only when active", async () => {
		const inactiveHarness = createHarness();
		const inactiveCtx = createContext(tempProject);
		const [inactiveResult] = await inactiveHarness.fire("before_agent_start", { systemPrompt: "Base" }, inactiveCtx);
		expect(inactiveResult).toBeUndefined();

		const activeHarness = createHarness();
		const activeCtx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);
		await activeHarness.fire("session_start", {}, activeCtx);
		const [activeResult] = await activeHarness.fire("before_agent_start", { systemPrompt: "Base" }, activeCtx) as [{ systemPrompt: string }];

		expect(activeResult.systemPrompt).toContain("Base");
		expect(activeResult.systemPrompt).toContain(OFFLINE_SYSTEM_PROMPT);
	});

	it("blocks web tools and wenchang delegation only while active", async () => {
		const inactiveHarness = createHarness();
		const inactiveCtx = createContext(tempProject);
		const [inactiveWebResult] = await inactiveHarness.fire("tool_call", { type: "tool_call", toolCallId: "web", toolName: "web_search", input: {} }, inactiveCtx);
		expect(inactiveWebResult).toBeUndefined();

		const activeHarness = createHarness();
		const activeCtx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);
		await activeHarness.fire("session_start", {}, activeCtx);
		const [webResult] = await activeHarness.fire("tool_call", { type: "tool_call", toolCallId: "web", toolName: "web_search", input: {} }, activeCtx);
		const [agentResult] = await activeHarness.fire("tool_call", { type: "tool_call", toolCallId: "agent", toolName: "Agent", input: { subagent_type: "wenchang" } }, activeCtx);

		expect(webResult).toMatchObject({ block: true, reason: expect.stringContaining("web_search") });
		expect(agentResult).toMatchObject({ block: true, reason: expect.stringContaining("wenchang") });
	});

	it("lets allowed Agent calls pass through without temporary parent model switching", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);

		await harness.fire("session_start", {}, ctx);
		const [result] = await harness.fire("tool_call", { type: "tool_call", toolCallId: "agent-1", toolName: "Agent", input: { subagent_type: "chengfeng" } }, ctx);

		expect(result).toBeUndefined();
		expect(harness.pi.setModel).not.toHaveBeenCalledWith(coderLocalModel);
	});

	it("disabling the active parent session restores the unfiltered registry", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);

		await harness.fire("session_start", {}, ctx);
		expect(ctx.modelRegistry.getAvailable()).toEqual([defaultLocalModel, coderLocalModel]);

		await harness.commands.get("offline")?.handler("off", ctx);

		expect(ctx.modelRegistry.getAvailable()).toEqual([cloudModel, defaultLocalModel, coderLocalModel]);
	});

	it("starts a different no-entry session inactive in the same extension instance", async () => {
		const harness = createHarness();
		const activeCtx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);
		await harness.fire("session_start", {}, activeCtx);
		expect(activeCtx.modelRegistry.getAvailable()).toEqual([defaultLocalModel, coderLocalModel]);

		const nextCtx = createContext(tempProject, defaultLocalModel);
		await harness.fire("session_start", {}, nextCtx);
		const [result] = await harness.fire("before_agent_start", { systemPrompt: "Base" }, nextCtx);

		expect(result).toBeUndefined();
		expect(nextCtx.ui.setStatus).toHaveBeenLastCalledWith("offline", undefined);
	});

	it("child sessions inherit offline tool guards from the shared registry policy", async () => {
		const registry = createMockRegistry([cloudModel, defaultLocalModel, coderLocalModel]);
		const parentHarness = createHarness();
		const parentCtx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		], registry);
		await parentHarness.fire("session_start", {}, parentCtx);

		const childHarness = createHarness();
		const childCtx = createContext(tempProject, defaultLocalModel, [], registry);
		await childHarness.fire("session_start", {}, childCtx);
		const [webResult] = await childHarness.fire("tool_call", { type: "tool_call", toolCallId: "web", toolName: "web_search", input: {} }, childCtx);

		expect(webResult).toMatchObject({ block: true, reason: expect.stringContaining("web_search") });
		expect(childHarness.appendedEntries).toEqual([]);
	});

	it("inactive child sessions do not disable a parent registry filter", async () => {
		const registry = createMockRegistry([cloudModel, defaultLocalModel, coderLocalModel]);
		const parentHarness = createHarness();
		const parentCtx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		], registry);
		await parentHarness.fire("session_start", {}, parentCtx);
		expect(registry.getAvailable()).toEqual([defaultLocalModel, coderLocalModel]);

		const childHarness = createHarness();
		const childCtx = createContext(tempProject, defaultLocalModel, [], registry);
		await childHarness.fire("session_start", {}, childCtx);
		await childHarness.commands.get("offline")?.handler("off", childCtx);

		expect(registry.getAvailable()).toEqual([defaultLocalModel, coderLocalModel]);
	});

	it("subagent fallback chain skips cloud candidates and selects local fallback", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);
		await harness.fire("session_start", {}, ctx);

		const resolved = resolveFirstAvailable([
			{ model: "anthropic/claude-sonnet" },
			{ model: "llama-swap/qwen3.6:27b" },
		], ctx.modelRegistry as never);

		expect(typeof resolveModel("anthropic/claude-sonnet", ctx.modelRegistry as never)).toBe("string");
		expect(resolved?.model).toBe(defaultLocalModel);
	});

	it("session shutdown removes the owner registry policy", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);
		await harness.fire("session_start", {}, ctx);
		expect(ctx.modelRegistry.getAvailable()).toEqual([defaultLocalModel, coderLocalModel]);

		await harness.fire("session_shutdown", {}, ctx);

		expect(ctx.modelRegistry.getAvailable()).toEqual([cloudModel, defaultLocalModel, coderLocalModel]);
	});

	it("shows the session-start notification once and not on every turn", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);

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

	it("resets session-start notification tracking for each session load", async () => {
		const harness = createHarness();
		const firstCtx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);
		await harness.fire("session_start", {}, firstCtx);
		await harness.fire("before_agent_start", { systemPrompt: "Base" }, firstCtx);
		expect(firstCtx.ui.notify).toHaveBeenCalledTimes(1);

		const secondCtx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);
		await harness.fire("session_start", {}, secondCtx);
		await harness.fire("before_agent_start", { systemPrompt: "Base" }, secondCtx);
		expect(secondCtx.ui.notify).toHaveBeenCalledTimes(1);
	});
});
