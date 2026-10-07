import { expect, it, vi } from "vitest";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import fastExtension from "../../extensions/fast/index.js";
import { ModeStateManager } from "../../extensions/modes/src/mode-state.js";
import { registerModeCommands } from "../../extensions/modes/src/commands.js";
import { registerModeHooks } from "../../extensions/modes/src/hooks.js";
import { readFastPolicy } from "../../extensions/lib/fast.js";
import { createFastSession } from "./helpers/fast-session.js";

const beta = "fast-mode-2026-02-01";

it("real mode hooks: user off survives prompts/reload and same-model transitions; headers never mutate", async () => {
	const modes: ExtensionFactory = (pi) => {
		const state = new ModeStateManager(pi);
		vi.spyOn(state, "loadConfig").mockImplementation((mode) => ({ body: "Test mode", toolRules: [], model: `anthropic/claude-opus-4-8${mode === "kuafu" ? ":fast" : ""}` }));
		registerModeCommands(pi, state);
		registerModeHooks(pi, state);
	};
	const conflict: ExtensionFactory = (pi) => {
		pi.on("before_provider_request", (event) => typeof event.payload === "object" && event.payload !== null ? { ...event.payload, speed: "fast" } : undefined);
		pi.on("before_provider_headers", (event) => { event.headers["ANTHROPIC-BETA"] = `request-other,${beta}`; });
	};
	const modelHeaders = { "Anthropic-Beta": `model-other,${beta}`, "anthropic-beta": "oauth-2025-04-20", custom: "keep" };
	const t = await createFastSession([conflict, fastExtension, modes], modelHeaders);
	try {
		await t.session.prompt("initial");
		expect(t.requests.at(-1)?.payload.speed).toBe("fast");
		await t.session.prompt("/fast");
		await t.session.prompt("off");
		await t.session.prompt("still off");
		expect(t.requests.slice(-2).every((request) => request.payload.speed === undefined)).toBe(true);
		await t.session.reload();
		await t.session.prompt("after reload");
		expect(t.requests.at(-1)?.payload.speed).toBeUndefined();
		expect(readFastPolicy(t.session.sessionManager.getBranch())).toMatchObject({ source: "user", enabled: false });
		await t.session.prompt("/mode houtu");
		await t.session.prompt("houtu off");
		expect(t.requests.at(-1)?.payload.speed).toBeUndefined();
		await t.session.prompt("/mode kuafu");
		await t.session.prompt("still off in kuafu");
		expect(t.requests.at(-1)?.payload.speed).toBeUndefined();
		for (const request of t.requests) {
			const tokens = request.headers.get("anthropic-beta")?.split(",").map((part) => part.trim()) ?? [];
			expect(tokens.includes(beta)).toBe(request.payload.speed === "fast");
			for (const token of ["model-other", "request-other", "oauth-2025-04-20"]) expect(tokens).toContain(token);
			expect(request.headers.get("custom")).toBe("keep");
		}
		expect(t.model.headers).toEqual(modelHeaders);
		expect(t.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	} finally { t.dispose(); }
});

it("real /fast retains inactive unsupported-model behavior and invalid-argument warning without outbound requests", async () => {
	const t = await createFastSession([fastExtension]);
	try {
		const model = t.runtime.getModel("anthropic", "claude-sonnet-4-6");
		if (!model) throw new Error("Missing unsupported model");
		await t.session.setModel(model);
		const notify = vi.spyOn(t.ctx.ui, "notify");
		await t.session.prompt("/fast");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("inactive"), "info");
		expect(readFastPolicy(t.session.sessionManager.getBranch())).toMatchObject({ enabled: true, source: "user" });
		await t.session.prompt("/fast invalid");
		expect(notify).toHaveBeenCalledWith("Usage: /fast", "warning");
		expect(t.requests).toHaveLength(0);
		await t.session.prompt("inactive");
		expect(t.requests[0].payload.speed).toBeUndefined();
		await t.session.setModel(t.model);
		await t.session.prompt("supported again");
		expect(t.requests.at(-1)?.payload.speed).toBe("fast");
	} finally { t.dispose(); }
});

it("real Codex transport receives strict priority after OAuth drift and strict off removes a conflicting priority field", async () => {
	const t = await createFastSession([(pi) => pi.on("before_provider_request", (event) => typeof event.payload === "object" && event.payload !== null ? { ...event.payload, service_tier: "priority" } : undefined), fastExtension]);
	const frames: Record<string, unknown>[] = [];
	class Socket extends EventTarget {
		readyState = 1;
		constructor() { super(); setTimeout(() => this.dispatchEvent(new Event("open")), 0); }
		close() { this.readyState = 3; }
		send(data: string) {
			frames.push(JSON.parse(data));
			setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "response.completed", response: { id: `resp_${frames.length}`, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }) })), 0);
		}
	}
	vi.stubGlobal("WebSocket", Socket);
	try {
		const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`;
		t.runtime.registerProvider("openai-codex", { apiKey: token, baseUrl: "http://127.0.0.1:1" });
		await t.runtime.refresh({ allowNetwork: false });
		const model = t.runtime.getModel("openai-codex", "gpt-5.5");
		if (!model) throw new Error("Missing Codex model");
		await t.session.setModel(model);
		// A previously validated frontmatter default remains fixed; provider auth is separate.
		expect(t.runtime.isUsingOAuth("openai-codex")).toBe(false);
		t.session.sessionManager.appendCustomEntry("fast-policy", { version: 1, mode: "kuafu", source: "mode", enabled: true });
		await t.session.prompt("strict on");
		expect(frames.at(-1)?.service_tier).toBe("priority");
		await t.session.prompt("/fast");
		await t.session.prompt("strict off");
		expect(frames).toHaveLength(2);
		expect(frames.at(-1)?.service_tier).toBeUndefined();
		expect(t.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	} finally { closeOpenAICodexWebSocketSessions(); t.dispose(); }
});

it("real CLIProxyAPI openai-responses transport sends priority only after /fast with local API-key auth", async () => {
	const t = await createFastSession([fastExtension]);
	t.fetchMock.mockImplementation(async (_input, init) => {
		t.requests.push({ payload: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
		return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${t.requests.length}`, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
	});
	try {
		t.runtime.registerProvider("cliproxyapi", {
			apiKey: "test-proxy-key",
			baseUrl: "http://127.0.0.1:1/v1",
			api: "openai-responses",
			models: [{ id: "gpt-6-astra", name: "GPT-6 Astra (test proxy)", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 }],
		});
		await t.runtime.refresh({ allowNetwork: false });
		const model = t.runtime.getModel("cliproxyapi", "gpt-6-astra");
		if (!model) throw new Error("Missing CLIProxyAPI model");
		await t.session.setModel(model);
		expect(t.runtime.isUsingOAuth("cliproxyapi")).toBe(false);
		await t.session.prompt("off");
		expect(t.requests.at(-1)?.payload.service_tier).toBeUndefined();
		await t.session.prompt("/fast");
		await t.session.prompt("on");
		expect(t.requests).toHaveLength(2);
		expect(t.requests.at(-1)?.payload.service_tier).toBe("priority");
		expect(t.session.messages.at(-1)).toMatchObject({ role: "assistant", api: "openai-responses", provider: "cliproxyapi", stopReason: "stop" });
	} finally { t.dispose(); }
});

it.each([false, true])("real branch bypass, backwards navigation and native file reopen retain explicit %s", async (enabled) => {
	const modes: ExtensionFactory = (pi) => {
		const state = new ModeStateManager(pi);
		vi.spyOn(state, "loadConfig").mockReturnValue({ body: "Test mode", toolRules: [], model: "anthropic/claude-opus-4-8" });
		registerModeHooks(pi, state);
	};
	const t = await createFastSession([fastExtension, modes], {}, true);
	const status = vi.fn();
	const assertActive = () => {
		expect(t.requests.at(-1)?.payload.speed).toBe(enabled ? "fast" : undefined);
		expect(t.requests.at(-1)?.headers.get("anthropic-beta")?.split(",").includes(beta) ?? false).toBe(enabled);
		expect(status).toHaveBeenLastCalledWith("fast", enabled ? "fast" : undefined);
	};
	try {
		await t.session.bindExtensions({ uiContext: { ...t.ctx.ui, setStatus: status } });
		await t.session.prompt("initial default");
		expect(t.requests.at(-1)?.payload.speed).toBeUndefined();
		const beforeToggle = t.session.sessionManager.getLeafId();
		if (!beforeToggle) throw new Error("Missing initial leaf");
		await t.session.prompt("/fast");
		if (!enabled) await t.session.prompt("/fast");
		// Native history navigation bypasses the custom entries, but not the user's session preference.
		expect((await t.session.navigateTree(beforeToggle, { summarize: false })).cancelled).toBe(false);
		expect(readFastPolicy(t.session.sessionManager.getBranch())?.source).not.toBe("user");
		await t.session.prompt("branch bypass");
		assertActive();
		await t.session.prompt("ordinary next request");
		assertActive();
		await t.session.navigateTree(beforeToggle, { summarize: false });
		await t.session.prompt("backwards again");
		assertActive();
		await t.session.reload();
		await t.session.prompt("after reload");
		assertActive();
		const firstKept = t.session.sessionManager.getBranch().find((entry) => entry.type === "message");
		if (!firstKept) throw new Error("Missing message for native compaction entry");
		t.session.sessionManager.appendCompaction("Compacted test history", firstKept.id, 1);
		await t.session.prompt("after compaction entry");
		assertActive();
		t.session.settingsManager.setRetryEnabled(true);
		const retries: string[] = [];
		const unsubscribe = t.session.subscribe((event) => { if (event.type === "auto_retry_start") retries.push(event.type); });
		t.fetchMock.mockImplementationOnce(async (_input, init) => {
			t.requests.push({ payload: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
			return new Response('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n', { headers: { "content-type": "text/event-stream" } });
		});
		const beforeRetry = t.requests.length;
		await t.session.prompt("retry after overload");
		unsubscribe();
		expect(retries).toHaveLength(1);
		expect(t.requests.slice(beforeRetry).map((request) => request.payload.speed)).toEqual([enabled ? "fast" : undefined, enabled ? "fast" : undefined]);
		assertActive();
		await t.reopen();
		await t.session.bindExtensions({ uiContext: { ...t.ctx.ui, setStatus: status } });
		await t.session.prompt("reopened persisted session");
		assertActive();
		expect(readFastPolicy(t.session.sessionManager.getBranch(), t.session.sessionManager.getEntries())).toMatchObject({ source: "user", enabled });
		await t.session.navigateTree(beforeToggle, { summarize: false });
		expect(readFastPolicy(t.session.sessionManager.getBranch())?.source).not.toBe("user");
		await t.session.prompt("/fast");
		await t.session.prompt("toggle session preference from earlier branch");
		expect(readFastPolicy(t.session.sessionManager.getBranch(), t.session.sessionManager.getEntries())).toMatchObject({ source: "user", enabled: !enabled });
		expect(t.requests.at(-1)?.payload.speed).toBe(enabled ? undefined : "fast");
		expect(status).toHaveBeenLastCalledWith("fast", enabled ? undefined : "fast");
	} finally { t.dispose(); }
	const fresh = await createFastSession([fastExtension, modes]);
	try {
		await fresh.session.prompt("new session configured default");
		expect(fresh.requests.at(-1)?.payload.speed).toBeUndefined();
		expect(readFastPolicy(fresh.session.sessionManager.getBranch(), fresh.session.sessionManager.getEntries())).toMatchObject({ source: "mode", enabled: false });
	} finally { fresh.dispose(); }
});
