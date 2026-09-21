import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { createFastSession } from "../../../test/integration/helpers/fast-session.js";
import { registerRuntimeModelFallback } from "../../lib/runtime-model-fallback.js";
import { registerModeHooks } from "../../modes/src/hooks.js";
import { ModeStateManager } from "../../modes/src/mode-state.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { compileJsonSchema } from "../src/graph/json-schema.js";

const chain = "anthropic/claude-opus-4-8:fast,anthropic/claude-sonnet-4-6:high";

it("main mode override recovers in the same transcript after quota settlement", async () => {
	const t = await createFastSession([pi => {
		const state = new ModeStateManager(pi);
		vi.spyOn(state, "loadConfig").mockReturnValue({ body: "", model: "anthropic/claude-opus-4-8" });
		state.modelOverride = chain;
		registerModeHooks(pi, state);
	}]);
	try {
		t.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { type: "quota_error", message: "quota exhausted" } }), { status: 402 }));
		await t.session.prompt("run once");
		await t.session.waitForIdle();
		expect(t.session.model?.id).toBe("claude-sonnet-4-6");
		expect(t.session.thinkingLevel).toBe("high");
		expect(t.session.messages.filter(m => m.role === "user")).toHaveLength(1);
		expect(t.session.messages.filter(m => m.role === "custom")).toEqual([expect.objectContaining({ display: false })]);
		expect(t.requests).toHaveLength(1);
	} finally { t.dispose(); }
});

it("isolated child waits through native retries and gated fallback before final output", async () => {
	const t = await createFastSession();
	vi.stubEnv("PI_CODING_AGENT_DIR", t.cwd);
	writeFileSync(join(t.cwd, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false } }));
	registerAgents(new Map([["recover", { name: "recover", description: "test", model: chain, extensions: false, excludeExtensions: ["subagent-model-fallback"], discoverSkills: false, preloadSkills: [], builtinToolNames: [], systemPrompt: "test", promptMode: "replace" }]]));
	const children: AgentSession[] = [];
	const success = t.fetchMock.getMockImplementation();
	if (!success) throw new Error("Missing fetch fixture");
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	let reached!: () => void;
	const recovering = new Promise<void>(resolve => { reached = resolve; });
	let calls = 0;
	t.fetchMock.mockImplementation(async (input, init) => {
		calls++;
		const payload = JSON.parse(String(init?.body));
		if (payload.model === "claude-opus-4-8") return new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "rate limit exceeded" } }), { status: 429 });
		reached();
		await gate;
		return success(input, init);
	});
	let settled = false;
	const running = runAgent(t.ctx, "recover", "run once", { pi: t.pi, isolated: true, onSessionCreated: session => { children.push(session); } }).then(result => { settled = true; return result; });
	try {
		await recovering;
		expect(settled).toBe(false);
		expect(calls).toBeGreaterThanOrEqual(3);
		release();
		const result = await running;
		expect(result.failure).toBeUndefined();
		expect(result.responseText).toBe("ok");
		expect(result.session.model?.id).toBe("claude-sonnet-4-6");
		expect(result.session.messages.filter(m => m.role === "user")).toHaveLength(1);
		expect(t.requests[0].payload.speed).toBeUndefined();
	} finally { release(); await running; for (const child of children) child.dispose(); registerAgents(new Map()); vi.unstubAllEnvs(); t.dispose(); }
});

it("resume waits for a fast fallback and reports only the recovered turn", async () => {
	const t = await createFastSession();
	vi.stubEnv("PI_CODING_AGENT_DIR", t.cwd);
	writeFileSync(join(t.cwd, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
	registerAgents(new Map([["resume-recover", { name: "resume-recover", description: "test", model: "anthropic/claude-sonnet-4-6,anthropic/claude-opus-4-8:high:fast", extensions: false, discoverSkills: false, preloadSkills: [], builtinToolNames: [], systemPrompt: "test", promptMode: "replace" }]]));
	const children: AgentSession[] = [];
	const success = t.fetchMock.getMockImplementation();
	if (!success) throw new Error("Missing fetch fixture");
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	let reached!: () => void;
	const recovering = new Promise<void>(resolve => { reached = resolve; });
	let fallbackPayload: Record<string, unknown> | undefined;
	let calls = 0;
	try {
		const initial = await runAgent(t.ctx, "resume-recover", "first", { pi: t.pi, isolated: true, onSessionCreated: session => { children.push(session); } });
		t.fetchMock.mockImplementation(async (input, init) => {
			calls++;
			const payload = JSON.parse(String(init?.body));
			if (payload.model === "claude-sonnet-4-6") return new Response(JSON.stringify({ error: { type: "quota_error", message: "quota exhausted" } }), { status: 402 });
			fallbackPayload = payload;
			reached();
			await gate;
			return success(input, init);
		});
		let settled = false;
		const resumed = resumeAgent(initial.session, "second").then(result => { settled = true; return result; });
		await recovering;
		expect(settled).toBe(false);
		expect(calls).toBe(2);
		release();
		const result = await resumed;
		expect(result.failure).toBeUndefined();
		expect(result.text).toBe("ok");
		expect(initial.session.thinkingLevel).toBe("high");
		expect(fallbackPayload?.speed).toBe("fast");
		expect(initial.session.messages.filter(m => m.role === "user")).toHaveLength(2);
	} finally { release(); for (const child of children) child.dispose(); registerAgents(new Map()); vi.unstubAllEnvs(); t.dispose(); }
});

it.each(["absent", "exhausted", "overflow", "nonquota", "cycle"])("settled recovery gate: %s", async kind => {
	const configured = kind === "absent" ? undefined : kind === "exhausted" ? "anthropic/claude-opus-4-8" : `${chain},anthropic/claude-opus-4-8`;
	const t = await createFastSession([pi => {
		registerRuntimeModelFallback(pi, { chain: () => configured, apply: () => {} });
	}]);
	try {
		const message = kind === "overflow" ? "prompt is too long: quota" : kind === "nonquota" ? "invalid API key" : "quota exhausted";
		t.fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { type: "error", message } }), { status: 400 }));
		await t.session.prompt("go");
		await t.session.waitForIdle();
		expect(t.fetchMock).toHaveBeenCalledTimes(kind === "cycle" ? 2 : 1);
		expect(t.session.messages.filter(m => m.role === "custom")).toHaveLength(kind === "cycle" ? 1 : 0);
	} finally { t.dispose(); }
});

it("keeps completed tools and defers structured-output repair until recovered output", async () => {
	const t = await createFastSession();
	vi.stubEnv("PI_CODING_AGENT_DIR", t.cwd);
	writeFileSync(join(t.cwd, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
	const path = join(t.cwd, "evidence.txt");
	writeFileSync(path, "retained evidence");
	registerAgents(new Map([["structured-recover", { name: "structured-recover", description: "test", model: chain, extensions: false, discoverSkills: false, preloadSkills: [], builtinToolNames: ["read"], systemPrompt: "test", promptMode: "replace" }]]));
	const schema = compileJsonSchema({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false });
	if (!schema.ok) throw new Error("Invalid test schema");
	const success = t.fetchMock.getMockImplementation();
	if (!success) throw new Error("Missing fetch fixture");
	const children: AgentSession[] = [];
	const payloads: string[] = [];
	let call = 0;
	const toolResponse = (name: string, input: object) => {
		const events = [
			{ type: "message_start", message: { id: "msg_tool", type: "message", role: "assistant", model: "claude-opus-4-8", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `tool_${call}`, name, input: {} } },
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		];
		return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	};
	t.fetchMock.mockImplementation(async (input, init) => {
		payloads.push(String(init?.body));
		call++;
		if (call === 1) return toolResponse("read", { path });
		if (call === 2) return new Response(JSON.stringify({ error: { type: "quota_error", message: "quota exhausted" } }), { status: 402 });
		if (call === 3) return toolResponse("StructuredOutput", { ok: true });
		return success(input, init);
	});
	try {
		const result = await runAgent(t.ctx, "structured-recover", "go", { pi: t.pi, isolated: true, structuredOutput: schema.compiled, onSessionCreated: session => { children.push(session); } });
		expect(result.failure).toBeUndefined();
		expect(result.structuredRetried).toBe(false);
		expect(JSON.parse(result.structuredJson ?? "null")).toEqual({ ok: true });
		expect(result.session.messages.filter(m => m.role === "toolResult" && m.toolName === "read")).toHaveLength(1);
		expect(payloads[2]).toContain("retained evidence");
		expect(result.session.messages.filter(m => m.role === "user")).toHaveLength(1);
	} finally { for (const child of children) child.dispose(); registerAgents(new Map()); vi.unstubAllEnvs(); t.dispose(); }
});
