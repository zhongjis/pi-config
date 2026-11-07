import { afterEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerRuntimeModelFallback } from "../../extensions/lib/runtime-model-fallback.js";
import { createFauxModelRuntime } from "./helpers/faux-runtime.js";

const originalError = "auth_unavailable: no auth available (providers=codex, model=gpt-6.1-sol; last upstream error: usage_limit_reached: The usage limit has been reached)";
const failure = (errorMessage = originalError) => fauxAssistantMessage([], { stopReason: "error", errorMessage });
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.useRealTimers(); });

type Scenario = { provider?: string; chain?: string; nativeRetries?: number; abort?: boolean };
async function setup(options: Scenario = {}) {
	const runtime = await createFauxModelRuntime({ provider: options.provider ?? "cliproxyapi", models: [{ id: "primary", reasoning: true }, { id: "secondary", reasoning: true }] });
	cleanups.push(runtime.dispose);
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: options.nativeRetries !== undefined, maxRetries: options.nativeRetries ?? 0, baseDelayMs: 1 } });
	const errors: string[] = [];
	const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.cwd(), settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [pi => {
		registerRuntimeModelFallback(pi, { chain: () => options.chain ?? `${runtime.model.provider}/primary,${runtime.model.provider}/secondary:high`, apply: () => {} });
		if (options.abort) pi.on("message_end", (event, ctx) => { if (event.message.role === "assistant" && event.message.stopReason === "error") ctx.abort(); });
	}] });
	await loader.reload();
	const { session } = await createAgentSession({ cwd: process.cwd(), agentDir: process.cwd(), model: runtime.model, modelRuntime: runtime.modelRuntime, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(), tools: [] });
	cleanups.push(() => session.dispose());
	await session.bindExtensions({ onError: error => errors.push(error.error) });
	const requests: string[] = [];
	const requestTimes: number[] = [];
	const contexts: string[] = [];
	vi.useFakeTimers();
	const run = async (responses: FauxResponseStep[]) => {
		runtime.faux.setResponses(responses.map(response => async (context, streamOptions, state, model) => {
			requests.push(model.id);
			requestTimes.push(Date.now());
			contexts.push(JSON.stringify(context));
			return typeof response === "function" ? response(context, streamOptions, state, model) : response;
		}));
		const running = session.prompt("continue");
		await vi.runAllTimersAsync();
		await running;
		await session.waitForIdle();
		expect(errors).toEqual([]);
	};
	return { session, run, requests, requestTimes, contexts };
}

it.each([
	"socket connection closed unexpectedly",
	"Unable to connect",
	"auth_unavailable: no auth available",
	"Codex error: invalid SSE data JSON (len=262138)",
	"malformed SSE frame",
	"truncated SSE frame",
])("retries a transient failure with backoff before fallback: %s", async error => {
	const t = await setup({ provider: "ordinary" });
	await t.run([...Array.from({ length: 5 }, () => failure(error)), fauxAssistantMessage("recovered")]);
	expect(t.requests).toEqual(["primary", "primary", "primary", "primary", "primary", "secondary"]);
	expect(t.requestTimes.map(time => time - t.requestTimes[0])).toEqual([0, 5_000, 35_000, 95_000, 215_000, 215_000]);
});

it("suppresses continuation and fallback when aborted during backoff", async () => {
	const t = await setup({ provider: "ordinary" });
	const running = t.run([failure("Unable to connect"), fauxAssistantMessage("must not run")]);
	setTimeout(() => { void t.session.abort(); }, 1_000);
	await running;
	expect(t.requests).toEqual(["primary"]);
	expect(t.session.model?.id).toBe("primary");
	expect(t.session.isIdle).toBe(true);
});

it("makes five total proxy quota attempts with backoff before advancing the chain", async () => {
	const t = await setup();
	await t.run([...Array.from({ length: 5 }, () => failure("quota exhausted")), fauxAssistantMessage("recovered")]);
	expect(t.requests).toEqual(["primary", "primary", "primary", "primary", "primary", "secondary"]);
	expect(t.requestTimes.map(time => time - t.requestTimes[0])).toEqual([0, 5_000, 35_000, 95_000, 215_000, 215_000]);
	expect(t.session.thinkingLevel).toBe("high");
	expect(t.session.messages.filter(message => message.role === "user")).toHaveLength(1);
});

it.each([2, 5])("recovers on proxy attempt %i without a synthetic continuation", async attempt => {
	const t = await setup();
	await t.run([...Array.from({ length: attempt - 1 }, () => failure()), fauxAssistantMessage("recovered")]);
	expect(t.requests).toEqual(Array.from({ length: attempt }, () => "primary"));
	expect(t.session.messages.filter(message => message.role === "custom")).toHaveLength(0);
	expect(t.session.messages.filter(message => message.role === "assistant")).toEqual([expect.objectContaining({ stopReason: "stop" })]);
	expect(t.session.sessionManager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "assistant")).toHaveLength(attempt);
});

it("starts a fresh quota budget after successful recovery and new user input", async () => {
	const t = await setup();
	await t.run([...Array.from({ length: 3 }, () => failure()), fauxAssistantMessage("recovered")]);
	await t.run([...Array.from({ length: 3 }, () => failure()), fauxAssistantMessage("recovered again")]);
	expect(t.requests).toEqual(Array.from({ length: 8 }, () => "primary"));
});

it.each([1, 5])("counts native retries (%i) without multiplying the quota budget", async nativeRetries => {
	const t = await setup({ nativeRetries });
	const failures = Math.max(5, nativeRetries + 1);
	await t.run([...Array.from({ length: failures }, (_, index) => failure(index <= nativeRetries ? "429 quota exhausted" : originalError)), fauxAssistantMessage("recovered")]);
	expect(t.requests).toEqual([...Array.from({ length: failures }, () => "primary"), "secondary"]);
});

it.each(["other", "rate", "access", "absent", "unavailable", "abort", "overflow"]) ("preserves recovery gate: %s", async kind => {
	const t = await setup({ provider: kind === "other" ? "ordinary" : undefined, chain: kind === "absent" ? "" : kind === "unavailable" ? "cliproxyapi/missing" : undefined, abort: kind === "abort" });
	const text = kind === "rate" ? "rate limit exceeded" : kind === "access" ? "403 permission denied" : kind === "overflow" ? "prompt is too long: quota" : originalError;
	await t.run([failure(text), fauxAssistantMessage("recovered")]);
	expect(t.requests).toEqual(["absent", "unavailable", "abort", "overflow"].includes(kind) ? ["primary"] : kind === "other" ? ["primary", "primary"] : ["primary", "secondary"]);
});

it.each([false, true])("exhausts five attempts per configured model then stays idle (single: %s)", async single => {
	const t = await setup({ chain: single ? "cliproxyapi/primary" : undefined });
	await t.run(Array.from({ length: single ? 5 : 10 }, () => failure()));
	expect(t.requests).toEqual(single
		? Array.from({ length: 5 }, () => "primary")
		: [...Array.from({ length: 5 }, () => "primary"), ...Array.from({ length: 5 }, () => "secondary")]);
	expect(t.session.isIdle).toBe(true);
});

it("preserves completed tool results while omitting failed assistant/tool pairs", async () => {
	const t = await setup();
	t.session.sessionManager.appendMessage({ role: "user", content: "earlier", timestamp: 0 });
	t.session.sessionManager.appendMessage(fauxAssistantMessage([fauxToolCall("read", {}, { id: "completed" })], { stopReason: "toolUse" }));
	t.session.sessionManager.appendMessage({ role: "toolResult", toolCallId: "completed", toolName: "read", content: [{ type: "text", text: "retained evidence" }], isError: false, timestamp: 0 });
	t.session.subscribe(event => {
		if (event.type === "agent_end" && event.messages.some(message => message.role === "assistant" && message.stopReason === "error")) {
			t.session.sessionManager.appendMessage({ role: "toolResult", toolCallId: "failed", toolName: "read", content: [{ type: "text", text: "orphan evidence" }], isError: true, timestamp: 0 });
		}
	});
	await t.run([fauxAssistantMessage([fauxToolCall("read", {}, { id: "failed" })], { stopReason: "error", errorMessage: originalError }), fauxAssistantMessage("recovered")]);
	expect(t.contexts[1]).not.toContain("orphan evidence");
	expect(t.contexts[1]).toContain("retained evidence");
	expect(t.contexts[1]).not.toContain(originalError);
	expect(t.requests).toEqual(["primary", "primary"]);
});
