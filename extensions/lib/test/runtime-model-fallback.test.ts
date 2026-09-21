import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { registerRuntimeModelFallback } from "../runtime-model-fallback.js";

type Model = { provider: string; id: string; name: string; contextWindow: number };
type Handler = (event: never, ctx: ExtensionContext) => void | Promise<void>;

const MODELS: Model[] = [
	{ provider: "test", id: "primary", name: "Primary", contextWindow: 100 },
	{ provider: "test", id: "fallback-one", name: "Fallback one", contextWindow: 100 },
	{ provider: "test", id: "fallback-two", name: "Fallback two", contextWindow: 100 },
];

function createHarness() {
	const handlers = new Map<string, Handler[]>();
	const selections: Model[] = [];
	const thinking: string[] = [];
	const continuations: Array<{ display: boolean; triggerTurn?: boolean }> = [];
	const applied: Array<{ fast?: boolean }> = [];
	let chain = "test/primary,test/fallback-one:low,test/fallback-two:high:fast";
	const controller = new AbortController();
	const ctx = {
		model: MODELS[0],
		signal: controller.signal,
		modelRegistry: {
			find(provider: string, id: string) {
				return MODELS.find((model) => model.provider === provider && model.id === id);
			},
			getAll() { return MODELS; },
			getAvailable() { return MODELS; },
		},
	};
	const fire = async (event: string, payload: unknown = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload as never, ctx as never);
	};
	const pi = {
		on(event: string, handler: Handler) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		async setModel(model: Model) {
			const previousModel = ctx.model;
			ctx.model = model;
			selections.push(model);
			await fire("model_select", { type: "model_select", model, previousModel, source: "set" });
			return true;
		},
		setThinkingLevel(level: string) { thinking.push(level); },
		sendMessage(message: { display: boolean }, options?: { triggerTurn?: boolean }) {
			continuations.push({ display: message.display, triggerTurn: options?.triggerTurn });
		},
	};
	registerRuntimeModelFallback(pi as never, {
		chain: () => chain,
		apply(candidate) { applied.push(candidate); },
	});
	return {
		abort: () => controller.abort(),
		applied,
		ctx,
		continuations,
		fire,
		selections,
		setChain(value: string) { chain = value; },
		thinking,
		userInput: () => fire("input", { type: "input", text: "continue", source: "interactive" }),
		extensionInput: () => fire("input", { type: "input", text: "continue", source: "extension" }),
	};
}

const quotaError = (errorMessage = "quota exceeded") => ({
	type: "message_end",
	message: { role: "assistant", stopReason: "error", errorMessage, usage: { input: 0, output: 0, cacheRead: 0 } },
});

async function settleQuota(harness: ReturnType<typeof createHarness>, errorMessage?: string): Promise<void> {
	await harness.fire("message_end", quotaError(errorMessage));
	await harness.fire("agent_settled", { type: "agent_settled" });
}

describe("registerRuntimeModelFallback", () => {
	it("continues after native retries settle, preserves episode attempts, and applies thinking", async () => {
		const harness = createHarness();
		await harness.userInput();
		await harness.fire("message_end", quotaError());
		await harness.fire("message_end", { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
		await harness.fire("agent_settled", { type: "agent_settled" });
		expect(harness.selections).toEqual([]);

		await settleQuota(harness);
		expect(harness.selections).toEqual([MODELS[1]]);
		expect(harness.thinking).toEqual(["low"]);
		expect(harness.continuations).toEqual([{ display: false, triggerTurn: true }]);
		expect(harness.ctx.model).toBe(MODELS[1]);

		await harness.extensionInput(); // Extension continuations must keep the current episode.
		harness.setChain("test/primary,test/fallback-two:high:fast");
		await settleQuota(harness);
		expect(harness.selections).toEqual([MODELS[1], MODELS[2]]);
		expect(harness.thinking).toEqual(["low", "high"]);
		expect(harness.applied.map((candidate) => candidate.fast)).toEqual([undefined, true]);
	});

	it("does not fall back after aborts, overflow, non-quota errors, or exhaustion", async () => {
		const cases = [
			{ message: { role: "assistant", stopReason: "aborted" } },
			{ message: { role: "assistant", stopReason: "error", errorMessage: "prompt is too long" } },
			{ message: { role: "assistant", stopReason: "error", errorMessage: "network disconnected" } },
		];
		for (const message of cases) {
			const harness = createHarness();
			await harness.userInput();
			await harness.fire("message_end", { type: "message_end", message });
			await harness.fire("agent_settled", { type: "agent_settled" });
			expect(harness.selections).toEqual([]);
		}

		const aborted = createHarness();
		await aborted.userInput();
		aborted.abort();
		await settleQuota(aborted);
		expect(aborted.selections).toEqual([]);

		const exhausted = createHarness();
		await exhausted.userInput();
		await settleQuota(exhausted);
		await settleQuota(exhausted);
		await settleQuota(exhausted);
		expect(exhausted.selections).toEqual([MODELS[1], MODELS[2]]);
	});

	it("cancels a pending fallback when the user manually selects a model", async () => {
		const harness = createHarness();
		await harness.userInput();
		await harness.fire("message_end", quotaError());
		harness.ctx.model = MODELS[1];
		await harness.fire("model_select", { type: "model_select", model: MODELS[1], previousModel: MODELS[0], source: "set" });
		await harness.fire("agent_settled", { type: "agent_settled" });
		expect(harness.selections).toEqual([]);
	});
});
