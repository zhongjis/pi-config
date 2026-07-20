import { statSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

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

describe("mode skill discovery", () => {
	it("discovers only the active mode skill directory", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		registerModeHooks(mock.pi as never, state);
		const cases = [
			{ mode: "kuafu", expected: [] },
			{ mode: "houtu", expected: [] },
			{ mode: "shennong", expected: [] },
			{ mode: "fuxi", expected: ["modes/fuxi/skills"] },
			{ mode: "luban", expected: ["modes/luban/skills"] },
		] as const;

		for (const { mode, expected } of cases) {
			state.currentMode = mode;
			const [discover] = await mock.fire("resources_discover", {}, createContext(mode));
			const skillPaths = (discover as { skillPaths: string[] }).skillPaths;
			const relativePaths = skillPaths.map((path) => path.replace(/^.*\/modes\//, "modes/"));

			expect(relativePaths).toEqual(expected);
		}
	});

	it("returns only an existing active-mode skill directory", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "fuxi";
		registerModeHooks(mock.pi as never, state);

		const [discover] = await mock.fire("resources_discover", {}, createContext("fuxi"));
		const skillPaths = (discover as { skillPaths: string[] }).skillPaths;

		expect(skillPaths).toHaveLength(1);
		expect(skillPaths.every((path) => statSync(path).isDirectory())).toBe(true);
	});

	it("does not eagerly inject skill content into context", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.currentMode = "fuxi";
		registerModeHooks(mock.pi as never, state);
		const ctx = createContext("fuxi");

		expect(await mock.fire("context", { messages: [] }, ctx)).toEqual([]);
		await mock.fire("session_compact", {}, ctx);
		expect(await mock.fire("context", { messages: [{ role: "compactionSummary" }] }, ctx)).toEqual([]);
	});

	it("reports resource reload requirements when switching into or out of Fu Xi", async () => {
		const mock = createMockPi();
		const state = new ModeStateManager(mock.pi as never);
		state.cachedConfigs["kuafu:default"] = { body: "" };
		state.cachedConfigs["fuxi:default"] = { body: "" };

		const ctx = { ...createContext("kuafu"), reload: vi.fn(async () => undefined) };

		await expect(state.switchMode("fuxi", ctx as never)).resolves.toBe(true);
		await expect(state.switchMode("kuafu", ctx as never)).resolves.toBe(true);

		expect(ctx.reload).not.toHaveBeenCalled();
	});
});
