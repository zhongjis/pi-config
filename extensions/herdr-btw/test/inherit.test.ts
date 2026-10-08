import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import { decideCacheMode, registerBtwExtension } from "../index.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { ContextStore } from "../src/context-store.ts";
import { buildAgentStartArgs, createPayload, isBtwPayload, type BtwPayload, type HerdrLaunchOptions } from "../src/core.ts";

const available = ["read", "web_enable", "web_search", "web_fetch"];
const selected = ["web_enable", "read"];
const payloadOptions = {
	createdAt: "2026-01-01T00:00:00Z",
	parentSessionId: "parent", parentPaneId: null,
	metadata: { generatedAt: "now", cwd: "/tmp", session: "parent", model: "test/model" },
	parentSystemPrompt: "parent system", parentActiveTools: selected,
	parentThinkingLevel: "standard", messages: [], draftQuestion: "",
	config: { ...DEFAULT_CONFIG },
};
const launch: HerdrLaunchOptions = {
	paneName: "btw", cwd: "/tmp", payloadPath: "/tmp/payload", model: "test/model",
	thinkingLevel: "standard", toolMode: "inherit", activeTools: selected, split: "right",
};

// Keep the registry separate from selection; the shared mock deliberately does not.
function localPi() {
	const mock = createMockPi();
	let active = [...available];
	const api = Object.assign(mock.pi, {
		getAllTools: () => available.map(name => ({ name })),
		getActiveTools: () => [...active],
		setActiveTools: vi.fn((names: string[]) => {
			if (names.some(name => !available.includes(name))) throw new Error("Unavailable tool");
			active = [...names];
		}),
	});
	return { ...mock, api };
}

// Invoke the actual extension at the dynamic mock boundary without claiming a framework API.
async function registerLocalBtw(
	pi: ReturnType<typeof localPi>["api"],
	options: Parameters<typeof registerBtwExtension>[1],
): Promise<void> {
	await Reflect.apply(registerBtwExtension, undefined, [pi, options]);
}

function startEvent() {
	const sections: Record<string, string> = { other: "kept" };
	return { sections, event: { type: "before_agent_start", prompt: "", systemPrompt: "child", systemPromptOptions: { sections } } };
}

const ui = { setTitle() {}, setWidget() {}, setEditorText() {}, notify() {}, theme: { fg: (_color: string, text: string) => text } };

describe("inherit availability", () => {
	let root: string;
	beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "btw-inherit-")); });
	afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

	async function child(overrides: Partial<BtwPayload> = {}) {
		const store = new ContextStore(root);
		const payload = { ...createPayload({ ...payloadOptions, parentAvailableTools: available }), ...overrides };
		vi.stubEnv("PI_HERDR_BTW_PAYLOAD", await store.create(payload));
		const mock = localPi();
		await registerLocalBtw(mock.api, { store });
		return { ...mock, payload };
	}

	it("supports current version-5 payloads with or without optional availability, validating and copying it", () => {
		expect(isBtwPayload(createPayload(payloadOptions))).toBe(true);
		const names = [...available];
		const payload = createPayload({ ...payloadOptions, parentAvailableTools: names });
		names.pop();
		expect(payload.parentAvailableTools).toEqual(available);
		expect(isBtwPayload(payload)).toBe(true);
		expect(isBtwPayload({ ...payload, parentAvailableTools: [] })).toBe(true);
		for (const invalid of [undefined, null, "read", [1]]) {
			expect(isBtwPayload({ ...payload, parentAvailableTools: invalid })).toBe(false);
		}
	});

	it("uses registered availability for CLI and falls back only when absent", () => {
		const args = buildAgentStartArgs({ ...launch, availableTools: available }, "child");
		expect(args[args.indexOf("--tools") + 1]).toBe(available.join(","));
		const withoutAvailability = buildAgentStartArgs(launch, "child");
		expect(withoutAvailability[withoutAvailability.indexOf("--tools") + 1]).toBe(selected.join(","));
		expect(buildAgentStartArgs({ ...launch, availableTools: [] }, "child")).toContain("--no-tools");
		expect(buildAgentStartArgs({ ...launch, activeTools: [] }, "child")).toContain("--no-tools");
	});

	it("omits mcp__ names from the inherit CLI allowlist", () => {
		const args = buildAgentStartArgs({ ...launch, availableTools: ["read", "mcp__srv__a", "web_search", "mcp__srv__b"] }, "child");
		expect(args[args.indexOf("--tools") + 1]).toBe("read,web_search");
	});

	it("passes MCP-only availability unchanged", () => {
		const names = ["mcp__srv__a", "mcp__srv__b"];
		const args = buildAgentStartArgs({ ...launch, availableTools: names }, "child");
		expect(args[args.indexOf("--tools") + 1]).toBe(names.join(","));
		expect(args).not.toContain("--no-tools");
	});

	it("keeps the typed command under the terminal line limit with a large MCP registry", () => {
		const MAX_CANON = 1024; // macOS terminal line limit for typed input
		const names = [
			...Array.from({ length: 40 }, (_, i) => `tool_${i}`),
			...Array.from({ length: 100 }, (_, i) => `mcp__server__tool_${String(i).padStart(3, "0")}`),
		];
		const args = buildAgentStartArgs({ ...launch, availableTools: names }, "child");
		const typed = "pi " + args.slice(args.indexOf("--") + 1).join(" ");
		expect(Buffer.byteLength(typed)).toBeLessThan(MAX_CANON);
	});

	it.each(["all", "read-only", "none"] as const)("leaves %s CLI behavior unchanged", toolMode => {
		const args = buildAgentStartArgs({ ...launch, toolMode, availableTools: available }, "child");
		if (toolMode === "all") {
			expect(args).not.toContain("--tools"); expect(args).not.toContain("--no-tools");
		} else if (toolMode === "none") expect(args).toContain("--no-tools");
		else expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,find,ls");
	});

	it("restores exact ordered selection after startup handlers, then preserves activation", async () => {
		const mock = await child();
		mock.pi.on("session_start", event => {
			if (event && typeof event === "object" && "reason" in event && event.reason === "startup") {
				mock.api.setActiveTools(["read", "web_enable"]);
			}
		});
		await mock.fireLifecycle("resources_discover");
		expect(mock.api.getActiveTools()).toEqual(available);
		await mock.fireLifecycle("session_start", { reason: "startup" }, { mode: "tui", ui });
		expect(mock.api.getActiveTools()).toEqual(["read", "web_enable"]);
		// Call directly to prove restoration is synchronous, not a deferred promise/timer.
		for (const handler of mock.lifecycleHandlers.get("resources_discover") ?? []) handler({}, {});
		expect(mock.api.getActiveTools()).toEqual(selected);
		expect(decideCacheMode(mock.payload, { model: "test/model", activeTools: selected, thinkingLevel: "standard" }).mode).toBe("native");
		expect(decideCacheMode(mock.payload, { model: "test/model", activeTools: [...selected].reverse(), thinkingLevel: "standard" }).mode).toBe("fallback");
		// The loader's registry predicate succeeds even though web tools started inactive.
		expect(mock.api.getAllTools().map(tool => tool.name)).toEqual(available);
		mock.api.setActiveTools([...selected, "web_search", "web_fetch"]);
		const activated = mock.api.getActiveTools();
		await mock.fireLifecycle("resources_discover");
		await mock.fireLifecycle("before_agent_start", startEvent().event, { model: { provider: "test", id: "model" } });
		await mock.fireLifecycle("context", { messages: [] });
		expect(mock.api.getActiveTools()).toEqual(activated);
		for (const reason of ["reload", "resume", "new", "fork"]) {
			await mock.fireLifecycle("session_start", { reason }, { mode: "tui", ui });
			await mock.fireLifecycle("resources_discover");
			expect(mock.api.getActiveTools()).toEqual(activated);
		}
	});

	it.each(["reload", "resume", "new", "fork"])("does not arm on %s", async reason => {
		const mock = await child();
		await mock.fireLifecycle("session_start", { reason }, { mode: "tui", ui });
		await mock.fireLifecycle("resources_discover");
		expect(mock.api.getActiveTools()).toEqual(available);
	});

	it("replays the exact parent prompt in native mode and sets only a section in fallback mode", async () => {
		const run = async (mock: Awaited<ReturnType<typeof child>>, activeTools: string[]) => {
			mock.api.setActiveTools(activeTools);
			const { sections, event } = startEvent();
			const [handler] = mock.lifecycleHandlers.get("before_agent_start") ?? [];
			const result = await handler(event, { model: { provider: "test", id: "model" } });
			return { sections, result };
		};
		const native = await run(await child(), selected);
		expect(native.result).toEqual({ systemPrompt: "parent system" });
		expect(native.sections).toEqual({ other: "kept" });
		const fallback = await run(await child(), [...selected].reverse());
		expect(fallback.result).toBeUndefined();
		expect(fallback.sections.other).toBe("kept");
		expect(fallback.sections.herdr_btw).toContain("focused /btw side pane");
		expect(fallback.sections.herdr_btw).toBe(fallback.sections.herdr_btw?.trim());
	});

	it.each(["print", "rpc"])("does not restore in %s descendants", async mode => {
		const mock = await child();
		await mock.fireLifecycle("session_start", { reason: "startup" }, { mode, ui });
		await mock.fireLifecycle("resources_discover");
		expect(mock.api.getActiveTools()).toEqual(available);
	});

	it.each(["all", "read-only", "none"] as const)("does not restore %s selection", async tools => {
		const mock = await child({ config: { ...DEFAULT_CONFIG, tools } });
		await mock.fireLifecycle("session_start", { reason: "startup" }, { mode: "tui", ui });
		await mock.fireLifecycle("resources_discover");
		expect(mock.api.getActiveTools()).toEqual(available);
	});

	it("does not restore payloads without availability, and restores an empty selection", async () => {
		const store = new ContextStore(root);
		vi.stubEnv("PI_HERDR_BTW_PAYLOAD", await store.create(createPayload(payloadOptions)));
		const mock = localPi();
		await registerLocalBtw(mock.api, { store });
		await mock.fireLifecycle("session_start", { reason: "startup" }, { mode: "tui", ui });
		await mock.fireLifecycle("resources_discover");
		expect(mock.api.getActiveTools()).toEqual(available);
		const empty = await child({ parentAvailableTools: [], parentActiveTools: [] });
		await empty.fireLifecycle("session_start", { reason: "startup" }, { mode: "tui", ui });
		await empty.fireLifecycle("resources_discover");
		expect(empty.api.getActiveTools()).toEqual([]);
	});

	it("captures parent registry separately and passes it to the launch", async () => {
		vi.stubEnv("PI_HERDR_BTW_PAYLOAD", ""); vi.stubEnv("HERDR_ENV", "1"); vi.stubEnv("HERDR_PANE_ID", "parent-pane");
		const mock = localPi(); mock.api.setActiveTools(selected);
		const exec = vi.fn().mockResolvedValueOnce({ code: 0, stdout: '{"result":{"pane":{"pane_id":"child"}}}', stderr: "" }).mockResolvedValue({ code: 0, stdout: "", stderr: "" });
		Object.assign(mock.pi, { exec });
		const store = new ContextStore(root);
		const create = vi.spyOn(store, "create");
		await registerLocalBtw(mock.api, { store, configStore: { load: async () => ({ ...DEFAULT_CONFIG }), save: async () => {}, reset: async () => ({ ...DEFAULT_CONFIG }) } });
		const ctx = { mode: "tui", ui, cwd: root, model: { provider: "test", id: "model" }, getSystemPrompt: () => "parent system", isIdle: () => true,
			sessionManager: { getSessionId: () => "parent", getSessionFile: () => undefined, getLeafId: () => null, getEntries: () => [{ type: "message", message: { role: "user", content: "hello" } }] },
		};
		const command = mock.commands.get("btw");
		if (!command || typeof command !== "object" || !("handler" in command) || typeof command.handler !== "function") {
			throw new Error("Expected a registered btw command with a callable handler");
		}
		await Reflect.apply(command.handler, command, ["question", ctx]);
		expect(create.mock.calls[0][0]).toMatchObject({ parentActiveTools: selected, parentAvailableTools: available });
		const args: string[] = exec.mock.calls[1][1];
		expect(args[args.indexOf("--tools") + 1]).toBe(available.join(","));
		await mock.fireLifecycle("session_shutdown");
	});
});
