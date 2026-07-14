import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
	const actual = await vi.importActual("node:fs") as typeof import("node:fs");
	return {
		...actual,
		readFileSync(path: Parameters<typeof actual.readFileSync>[0], options?: Parameters<typeof actual.readFileSync>[1]) {
			const normalizedPath = String(path).replace(/\\/g, "/");
			if (normalizedPath.endsWith("/modes/fuxi/skills/-plan/SKILL.md")) {
				return "---\nname: ulw-plan\n---\nFu Xi plan skill body";
			}
			return actual.readFileSync(path, options as never);
		},
	};
});

import { registerModeHooks } from "../src/hooks.js";
import { ModeStateManager } from "../src/mode-state.js";

function createMockPi() {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown | Promise<unknown>>>();

	return {
		pi: {
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown | Promise<unknown>) {
				const next = handlers.get(event) ?? [];
				next.push(handler);
				handlers.set(event, next);
			},
			getAllTools: () => [],
			getActiveTools: () => [],
			setActiveTools: vi.fn(),
			setModel: vi.fn(),
			appendEntry: vi.fn(),
			getFlag: vi.fn(() => undefined),
			sendUserMessage: vi.fn(),
			getThinkingLevel: vi.fn(() => "off"),
			setThinkingLevel: vi.fn(),
		},
		async fire(event: string, payload: unknown, ctx: unknown) {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) {
				results.push(await handler(payload, ctx));
			}
			return results;
		},
	};
}

function createContext(mode: string) {
	return {
		hasUI: false,
		ui: { setStatus: vi.fn(), setEditorComponent: vi.fn() },
		modelRegistry: { getAll: () => [], getAvailable: () => [] },
		sessionManager: {
			getSessionId: () => "session-1",
			getEntries: () => [
				{ type: "custom", customType: "agent-mode", data: { mode } },
			],
		},
	};
}

function hasInjectedPlanSkill(result: unknown): boolean {
	const messages = (result as { messages?: unknown[] } | undefined)?.messages;
	return Boolean(JSON.stringify(messages).includes("Fu Xi plan skill body"));
}

describe("mode-specific skill bootstrap", () => {
	it("discovers and injects Fu Xi mode skills only while Fu Xi is active", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "fuxi";
		state.cachedConfigs["fuxi:default"] = { body: "" };
		registerModeHooks(mock.pi as never, state);

		const fuxiCtx = createContext("fuxi");
		const [discover] = await mock.fire("resources_discover", {}, fuxiCtx);
		expect(discover).toMatchObject({
			skillPaths: [expect.stringMatching(/modes\/fuxi\/skills$/)],
		});

		await mock.fire("session_start", {}, fuxiCtx);
		const [firstContext] = await mock.fire("context", { messages: [] }, fuxiCtx);
		expect(hasInjectedPlanSkill(firstContext)).toBe(true);

		const [duplicateContext] = await mock.fire("context", { messages: (firstContext as { messages: unknown[] }).messages }, fuxiCtx);
		expect(duplicateContext).toBeUndefined();

		await mock.fire("session_compact", {}, fuxiCtx);
		const [afterCompact] = await mock.fire("context", { messages: [{ role: "compactionSummary", content: "summary" }] }, fuxiCtx);
		expect(hasInjectedPlanSkill(afterCompact)).toBe(true);

		const kuafuCtx = createContext("kuafu");
		state.currentMode = "kuafu";
		const [kuafuDiscover] = await mock.fire("resources_discover", {}, kuafuCtx);
		expect(kuafuDiscover).toEqual({ skillPaths: [] });
		const [kuafuContext] = await mock.fire("context", { messages: [] }, kuafuCtx);
		expect(kuafuContext).toBeUndefined();
	});

	it("reloads when switching into or out of Fu Xi", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.cachedConfigs["kuafu:default"] = { body: "" };
		state.cachedConfigs["fuxi:default"] = { body: "" };

		const ctx = { ...createContext("kuafu"), reload: vi.fn(async () => undefined) };

		await state.switchMode("fuxi", ctx as never);
		expect(ctx.reload).toHaveBeenCalledTimes(1);

		await state.switchMode("kuafu", ctx as never);
		expect(ctx.reload).toHaveBeenCalledTimes(2);
	});
});
