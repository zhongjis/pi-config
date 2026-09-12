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

it("real mode hooks: default fast, /fast off across prompts/reload, same-model transition resets and headers never mutate", async () => {
	const modes: ExtensionFactory = (pi) => {
		const state = new ModeStateManager(pi);
		vi.spyOn(state, "loadConfig").mockImplementation((mode) => ({ body: "Test mode", model: `anthropic/claude-opus-4-8${mode === "kuafu" ? ":fast" : ""}` }));
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
		await t.session.prompt("reset on");
		expect(t.requests.at(-1)?.payload.speed).toBe("fast");
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
		const model = t.runtime.getModel("openai-codex", "gpt-5.4");
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
