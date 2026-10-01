import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { readFastPolicy } from "../../lib/fast.js";
import { ModeStateManager } from "../src/mode-state.js";
import type { Mode, ModeConfig } from "../src/types.js";

vi.mock("../src/config-loader.js", () => ({ loadAgentConfig: () => ({ body: "" }) }));

function setup() {
	const model = { provider: "anthropic", id: "claude-opus-4-8", api: "anthropic-messages", name: "Opus" };
	const entries: unknown[] = [];
	const configs: Partial<Record<Mode, ModeConfig>> = {
		kuafu: { body: "build", model: "missing:fast,anthropic/claude-opus-4-8:fast" },
		houtu: { body: "execute", model: "anthropic/claude-opus-4-8" },
	};
	const pi = {
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		getAllTools: () => [], getActiveTools: () => [], setActiveTools: vi.fn(),
		setModel: vi.fn(async () => true), getThinkingLevel: () => "off", setThinkingLevel: vi.fn(),
		events: { emit: vi.fn() },
	} as unknown as ExtensionAPI;
	const ctx = {
		model, modelRegistry: { getAvailable: () => [model], find: () => model, isUsingOAuth: () => false },
		sessionManager: { getBranch: () => entries, getEntries: () => entries, getSessionId: () => "test" }, ui: { setStatus: vi.fn() },
	} as unknown as ExtensionContext;
	const state = new ModeStateManager(pi);
	vi.spyOn(state, "loadConfig").mockImplementation((mode: Mode) => configs[mode] ?? { body: "" });
	return { state, ctx, entries, configs, pi };
}

it("user off survives repeated prompts, reload and same-model mode transitions", async () => {
	const { state, ctx, entries, pi } = setup();
	await state.applyMode(ctx);
	expect(readFastPolicy(entries)).toMatchObject({ mode: "kuafu", source: "mode", enabled: true });
	pi.appendEntry("fast-policy", { version: 1, mode: "kuafu", source: "user", enabled: false });
	await state.applyModelFromConfig(state.loadConfig("kuafu"), ctx);
	await state.switchMode("kuafu", ctx);
	expect(readFastPolicy(entries)).toMatchObject({ source: "user", enabled: false });
	const restored = new ModeStateManager(pi);
	await restored.applyModelFromConfig(state.loadConfig("kuafu"), ctx);
	expect(readFastPolicy(entries)).toMatchObject({ source: "user", enabled: false });
	await state.switchMode("houtu", ctx);
	expect(readFastPolicy(entries)).toMatchObject({ source: "user", enabled: false });
	await state.switchMode("kuafu", ctx);
	expect(readFastPolicy(entries)).toMatchObject({ source: "user", enabled: false });
	expect(pi.setModel).not.toHaveBeenCalled();
});

it("unsupported selected fast fails without fallback or corrupting current mode/policy/tool state", async () => {
	const { state, ctx, configs, entries, pi } = setup();
	await state.applyMode(ctx);
	configs.houtu = { body: "execute", model: "anthropic/claude-opus-4-8:fast,anthropic/claude-opus-4-8" };
	const unsupported = { ...ctx.model, id: "claude-sonnet-4-6" };
	vi.spyOn(ctx.modelRegistry, "find").mockReturnValue(unsupported as NonNullable<ExtensionContext["model"]>);
	const before = entries.length;
	await expect(state.switchMode("houtu", ctx)).rejects.toThrow("Explicit :fast is unsupported");
	expect(state.currentMode).toBe("kuafu");
	expect(entries).toHaveLength(before);
	expect(pi.setModel).not.toHaveBeenCalled();
	expect(pi.setActiveTools).not.toHaveBeenCalled();
});

it("without a user preference same-model transitions reset to each mode default", async () => {
	const { state, ctx, entries } = setup();
	await state.applyMode(ctx);
	expect(readFastPolicy(entries)).toMatchObject({ mode: "kuafu", source: "mode", enabled: true });
	await state.switchMode("houtu", ctx);
	expect(readFastPolicy(entries)).toMatchObject({ mode: "houtu", source: "mode", enabled: false });
	await state.switchMode("kuafu", ctx);
	expect(readFastPolicy(entries)).toMatchObject({ mode: "kuafu", source: "mode", enabled: true });
});

it.each([false, true])("explicit %s survives model override/reset and runtime fallback defaults", async (enabled: boolean) => {
	const { state, ctx, entries, pi } = setup();
	await state.applyMode(ctx);
	pi.appendEntry("fast-policy", { version: 1, mode: "kuafu", source: "user", enabled });
	state.modelOverride = "anthropic/claude-opus-4-8";
	await state.applyModelFromConfig(state.loadConfig("kuafu"), ctx, true);
	expect(readFastPolicy(entries)).toMatchObject({ source: "user", enabled });
	state.modelOverride = undefined;
	await state.applyModelFromConfig(state.loadConfig("kuafu"), ctx, true);
	expect(readFastPolicy(entries)).toMatchObject({ source: "user", enabled });
	const model = ctx.model;
	if (!model) throw new Error("Missing test model");
	state.applyRuntimeModel({ model, fast: !enabled }, ctx);
	expect(readFastPolicy(entries)).toMatchObject({ source: "user", enabled });
});
