import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

/** Real Anthropic provider/SDK hooks; only the HTTP boundary is replaced. */
export async function createFastSession(factories: ExtensionFactory[] = [], headers: Record<string, string> = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-fast-"));
	const requests: { payload: Record<string, unknown>; headers: Headers }[] = [];
	const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		requests.push({ payload: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
		const events = [
			{ type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-opus-4-8", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		];
		return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	});
	vi.stubGlobal("fetch", fetchMock);
	try {
		const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, authPath: join(cwd, "auth.json"), modelsStorePath: join(cwd, "models.json") });
		runtime.registerProvider("anthropic", { apiKey: "sk-ant-oat01-local-test", baseUrl: "http://127.0.0.1:1" });
		await runtime.refresh({ allowNetwork: false });
		const model = runtime.getModel("anthropic", "claude-opus-4-8");
		if (!model) throw new Error("Missing Anthropic test model");
		model.headers = Object.freeze({ ...headers });
		Object.freeze(model);
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		let ctx: ExtensionContext | undefined;
		let pi: ExtensionAPI | undefined;
		const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [
			...factories, (api) => {
				pi = api;
				api.on("session_start", (_event, context) => { ctx = context; });
			},
		] });
		await loader.reload();
		const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime: runtime, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), tools: [], thinkingLevel: "off" });
		await session.bindExtensions({});
		if (!ctx || !pi) { session.dispose(); throw new Error("Context/API was not captured"); }
		return { session, ctx, pi, model, runtime, requests, cwd, fetchMock, dispose: () => { session.dispose(); vi.unstubAllGlobals(); rmSync(cwd, { recursive: true, force: true }); } };
	} catch (error) {
		vi.unstubAllGlobals();
		rmSync(cwd, { recursive: true, force: true });
		throw error;
	}
}
