import { getFastEligibility, getFastProfile, transformFastHeaders, transformFastPayload } from "../fast.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import fastExtension from "../../fast/index.js";

const codex = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.4" };
const anthropic = { provider: "anthropic", api: "anthropic-messages", id: "claude-opus-4-8" };
const beta = "fast-mode-2026-02-01";

// Capture only registration; invoke the real extension's command and request hook.
function baseline(model: typeof codex & { headers?: Record<string, string> }, usingOAuth = true) {
	const on = vi.fn<(name: string, handler: (...args: unknown[]) => unknown) => void>();
	const registerCommand = vi.fn<ExtensionAPI["registerCommand"]>();
	const entries: unknown[] = [];
	Reflect.apply(fastExtension, undefined, [{ on, registerCommand, appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }), events: { on: () => () => {}, emit: vi.fn() } }]);
	const ctx = {
		model, modelRegistry: { isUsingOAuth: () => usingOAuth },
		sessionManager: { getBranch: () => entries }, hasUI: false, ui: { notify: vi.fn() },
	};
	const command = registerCommand.mock.calls[0][1];
	const request = on.mock.calls.find(([name]) => name === "before_provider_request")?.[1];
	if (!request) throw new Error("Missing request registration");
	return {
		toggle: () => Reflect.apply(command.handler, command, ["", ctx]),
		headers: (headers: Record<string, string>) => {
			const hook = on.mock.calls.find(([name]) => name === "before_provider_headers")?.[1];
			if (!hook) throw new Error("Missing headers registration");
			Reflect.apply(hook, undefined, [{ headers }, ctx]);
			return headers;
		},
		request: (payload: unknown) => Reflect.apply(request, undefined, [{ payload }, ctx]),
	};
}

describe("existing fast factory characterization", () => {
	it("codex defaults off, injects priority with OAuth, and preserves explicit payload precedence", async () => {
		const fast = baseline({ ...codex });
		const payload = { model: codex.id };
		expect(fast.request(payload)).toBeUndefined();
		await fast.toggle();
		expect(fast.request(payload)).toEqual({ ...payload, service_tier: "priority" });
		expect(fast.request({ ...payload, service_tier: "default" })).toBeUndefined();
		const apiKey = baseline({ ...codex }, false);
		await apiKey.toggle();
		expect(apiKey.request(payload)).toBeUndefined();
	});
	it("anthropic injects speed and OAuth betas, preserves other headers, and removes only fast beta on toggle off", async () => {
		const model = { ...anthropic, headers: { "Anthropic-Beta": "other", custom: "keep" } };
		const fast = baseline(model);
		await fast.toggle();
		expect(fast.request({ model: model.id })).toEqual({ model: model.id, speed: "fast" });
		expect(fast.headers({})).toEqual({ custom: "keep", "Anthropic-Beta": `other,claude-code-20250219,oauth-2025-04-20,${beta}`, "anthropic-beta": `other,claude-code-20250219,oauth-2025-04-20,${beta}` });
		expect(model.headers).toEqual({ "Anthropic-Beta": "other", custom: "keep" });
		expect(fast.request({ model: model.id, speed: "normal" })).toBeUndefined();
		await fast.toggle();
		expect(fast.headers({ "anthropic-beta": `oauth-2025-04-20,${beta}` })).toEqual({ custom: "keep", "Anthropic-Beta": "other,oauth-2025-04-20", "anthropic-beta": "other,oauth-2025-04-20" });
		expect(model.headers).toEqual({ "Anthropic-Beta": "other", custom: "keep" });
	});
});

describe("stateless fast primitives", () => {
	it.each([
		... ["gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra"].map((id) => ({ model: { ...codex, id }, usingOAuth: true, field: "service_tier", value: "priority" })),
		... ["claude-opus-4-8", "claude-opus-5"].map((id) => ({ model: { ...anthropic, id }, usingOAuth: false, field: "speed", value: "fast" })),
	])("supports verified $model.id eligibility and payload", ({ model, usingOAuth, field, value }) => {
		expect(getFastEligibility(model, usingOAuth).eligible).toBe(true);
		for (const strict of [false, true]) {
			const policy = { enabled: true, usingOAuth, strict };
			expect(transformFastPayload({ model: model.id }, model, policy)).toEqual({ model: model.id, [field]: value });
			if (model.provider === "anthropic") expect(transformFastHeaders(undefined, model, policy)).toEqual({ "anthropic-beta": beta });
		}
	});
	it.each([
		... ["claude-opus-4-6", "claude-opus-4-7", "claude-opus-5-latest"].map((id) => ({ ...anthropic, id })),
		... ["gpt-5.6", "codex-auto-review", "gpt-6-astra-latest"].map((id) => ({ ...codex, id })),
	])("rejects removed or unverified $id in interactive and strict paths", (model) => {
		expect(getFastEligibility(model, true).eligible).toBe(false);
		for (const strict of [false, true]) {
			const policy = { enabled: true, usingOAuth: true, strict };
			expect(transformFastPayload({ model: model.id }, model, policy)).toBeUndefined();
			expect(transformFastHeaders(undefined, model, policy)).toEqual({});
			if (model.provider === "anthropic") expect(transformFastHeaders({ "anthropic-beta": `other,${beta}` }, model, policy)).toEqual({ "anthropic-beta": "other" });
		}
	});
	it("retains exact profiles and rejects unsupported provider, API, ID, or Codex API-key auth", () => {
		expect(getFastProfile(codex)?.models).toEqual(["gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra"]);
		expect(getFastProfile(anthropic)?.models).toEqual(["claude-opus-4-8", "claude-opus-5"]);
		for (const model of [undefined, { ...codex, provider: "luna" }, { ...codex, api: "openai-responses" }, { ...codex, id: "gpt-5" }]) {
			expect(getFastEligibility(model, true).eligible).toBe(false);
			expect(transformFastPayload({ model: model?.id }, model, { enabled: true, usingOAuth: true, strict: true })).toBeUndefined();
		}
		expect(getFastEligibility(codex, false).eligible).toBe(false);
		expect(getFastProfile(anthropic)?.describeInjection).toBe("speed=fast");
	});
	it("strict on overrides conflicts; interactive on preserves precedence and validates payload identity", () => {
		for (const [model, field, value] of [[codex, "service_tier", "priority"], [anthropic, "speed", "fast"]] as const) {
			const payload = Object.freeze({ model: model.id, [field]: "normal", keep: true });
			const policy = { enabled: true, usingOAuth: true };
			expect(transformFastPayload(payload, model, policy)).toBeUndefined();
			expect(transformFastPayload(payload, model, { ...policy, strict: true })).toEqual({ ...payload, [field]: value });
			expect(transformFastPayload({ model: model.id }, model, policy)).toEqual({ model: model.id, [field]: value });
			for (const invalid of [null, [], "text", { model: "other" }]) expect(transformFastPayload(invalid, model, { ...policy, strict: true })).toBeUndefined();
		}
	});
	it("strict off strips only fast values, even on unsupported model IDs, without changing inputs", () => {
		const model = { ...codex, id: "future" };
		const payload = Object.freeze({ model: model.id, service_tier: "priority", speed: "fast", keep: true });
		expect(transformFastPayload(payload, model, { enabled: false, usingOAuth: false, strict: true })).toEqual({ model: model.id, speed: "fast", keep: true });
		expect(transformFastPayload({ model: anthropic.id, speed: "fast", keep: 1 }, anthropic, { enabled: false, usingOAuth: false, strict: true })).toEqual({ model: anthropic.id, keep: 1 });
		expect(transformFastPayload({ model: codex.id, service_tier: "default" }, codex, { enabled: false, usingOAuth: true, strict: true })).toBeUndefined();
		expect(transformFastPayload(payload, model, { enabled: false, usingOAuth: true })).toBeUndefined();
	});
	it("transforms request-local mixed-case beta headers without mutating shared model or unrelated tokens", () => {
		const headers = Object.freeze({ "Anthropic-Beta": `other,${beta}`, "ANTHROPIC-BETA": "another", custom: "keep" });
		const model = Object.freeze({ ...anthropic, headers });
		const on = transformFastHeaders(headers, model, { enabled: true, usingOAuth: true, strict: true });
		const enabledBetas = `other,${beta},another,claude-code-20250219,oauth-2025-04-20`;
		expect(on).toEqual({ custom: "keep", "Anthropic-Beta": enabledBetas, "ANTHROPIC-BETA": enabledBetas, "anthropic-beta": enabledBetas });
		const disabledBetas = "other,another,claude-code-20250219,oauth-2025-04-20";
		expect(transformFastHeaders(on, model, { enabled: false, usingOAuth: true, strict: true })).toEqual({ custom: "keep", "Anthropic-Beta": disabledBetas, "ANTHROPIC-BETA": disabledBetas, "anthropic-beta": disabledBetas });
		expect(model.headers).toBe(headers);
		expect(transformFastHeaders(undefined, anthropic, { enabled: true, usingOAuth: false })).toEqual({ "anthropic-beta": beta });
		expect(transformFastHeaders({ "anthropic-beta": beta }, anthropic, { enabled: false, usingOAuth: false, strict: true })).toEqual({ "anthropic-beta": "" });
		expect(transformFastHeaders(undefined, { ...anthropic, id: "unsupported" }, { enabled: true, usingOAuth: true })).toEqual({});
		for (const model of [{ ...anthropic, provider: "other" }, { ...anthropic, api: "other" }, { ...anthropic, id: "unsupported" }]) {
			expect(transformFastHeaders(undefined, model, { enabled: true, usingOAuth: false, strict: true })).toEqual({});
		}
	});
});

it("validated strict policy preserves fast metadata after OAuth eligibility drift", () => {
	expect(transformFastPayload({ model: codex.id, service_tier: "default" }, codex, { enabled: true, usingOAuth: false, strict: true })).toEqual({ model: codex.id, service_tier: "priority" });
	expect(transformFastPayload({ model: codex.id }, codex, { enabled: true, usingOAuth: false })).toBeUndefined();
});

it("masks every observed beta casing including empty removal without touching the model headers", () => {
	const headers = Object.freeze({ "Anthropic-Beta": beta, "ANTHROPIC-BETA": beta });
	expect(transformFastHeaders(headers, anthropic, { enabled: false, usingOAuth: true, strict: true })).toEqual({ "Anthropic-Beta": "", "ANTHROPIC-BETA": "", "anthropic-beta": "" });
});
