import { describe, expect, it, vi } from "vitest";

import { registerModeCommands } from "../src/commands.js";
import type { ModeStateManager } from "../src/mode-state.js";
import type { Mode } from "../src/types.js";

interface RegisteredCommand {
	description: string;
	handler: (args: string, ctx: { ui: { notify?: ReturnType<typeof vi.fn>; select: ReturnType<typeof vi.fn> }; reload?: ReturnType<typeof vi.fn>; }) => Promise<void>;
}


function createMockPi() {
	const commands = new Map<string, RegisteredCommand>();

	return {
		commands,
		pi: {
			registerFlag: vi.fn(),
			registerCommand: vi.fn((name: string, command: RegisteredCommand) => {
				commands.set(name, command);
			}),
			on: vi.fn(),
			registerShortcut: vi.fn(),
			sendUserMessage: vi.fn(),
		},
	};
}

describe("registerModeCommands", () => {
	it("switches to the selected mode from the no-args selector", async () => {
		const mock = createMockPi();
		const state = {
			currentMode: "kuafu" as Mode,
			switchMode: vi.fn(async () => {}),
		};

		registerModeCommands(mock.pi as never, state as unknown as ModeStateManager);

		const modeCommand = mock.commands.get("mode");
		expect(modeCommand).toBeDefined();

		const select = vi.fn(async (_title: string, items: string[]) => items[3]);
		await modeCommand?.handler("", { ui: { select } });

		expect(select).toHaveBeenCalledWith("Agent Mode", expect.any(Array));
		expect(state.switchMode).toHaveBeenCalledWith("luban", { ui: { select } });
	});

	it("terminally reloads resource-changing prompt switches and asks for resubmission", async () => {
		const mock = createMockPi();
		const notify = vi.fn();
		const reload = vi.fn(async () => {});
		const state = {
			currentMode: "kuafu" as Mode,
			switchMode: vi.fn(async () => true),
		};

		registerModeCommands(mock.pi as never, state as unknown as ModeStateManager);
		const command = mock.commands.get("mode:fuxi");

		await command?.handler("draft next plan", { ui: { notify, select: vi.fn() }, reload });

		expect(state.switchMode).toHaveBeenCalledWith("fuxi", expect.any(Object));
		expect(reload).toHaveBeenCalledTimes(1);
		expect(mock.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("resubmit"), "info");
	});

	it("preserves follow-up prompt behavior when mode switch does not require resource reload", async () => {
		const mock = createMockPi();
		const notify = vi.fn();
		const reload = vi.fn(async () => {});
		const state = {
			currentMode: "kuafu" as Mode,
			switchMode: vi.fn(async () => false),
		};

		registerModeCommands(mock.pi as never, state as unknown as ModeStateManager);
		const command = mock.commands.get("mode:houtu");

		await command?.handler("continue existing task", { ui: { notify, select: vi.fn() }, reload });

		expect(reload).not.toHaveBeenCalled();
		expect(mock.pi.sendUserMessage).toHaveBeenCalledWith("continue existing task", { deliverAs: "followUp" });
		expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("resubmit"), expect.any(String));
	});


	it("shows mode model info with no args", async () => {
		const mock = createMockPi();
		const notify = vi.fn();
		const state = {
			currentMode: "kuafu" as Mode,
			modelOverride: undefined,
			loadConfig: vi.fn(() => ({ body: "build", model: "anthropic/claude-opus-4" })),
			applyMode: vi.fn(async () => {}),
			persistState: vi.fn(),
		};

		registerModeCommands(mock.pi as never, state as unknown as ModeStateManager);
		const command = mock.commands.get("mode-model");
		expect(command).toBeDefined();

		await command?.handler("", {
			ui: { notify, select: vi.fn() },
			model: { provider: "anthropic", id: "claude-sonnet-4" },
			modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined },
		} as never);

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Mode: kuafu"),
			"info",
		);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Override: (none)"),
			"info",
		);
	});

	it("sets model override from args", async () => {
		const mock = createMockPi();
		const notify = vi.fn();
		const state = {
			currentMode: "kuafu" as Mode,
			modelOverride: undefined,
			loadConfig: vi.fn(() => ({ body: "build", model: "anthropic/claude-opus-4" })),
			applyMode: vi.fn(async () => {}),
			persistState: vi.fn(),
		};

		registerModeCommands(mock.pi as never, state as unknown as ModeStateManager);
		const command = mock.commands.get("mode-model");

		const registry = {
			getAll: () => [{ id: "gpt-4o", name: "GPT-4o", provider: "openai" }],
			getAvailable: () => [{ id: "gpt-4o", name: "GPT-4o", provider: "openai" }],
			find: () => ({ id: "gpt-4o", name: "GPT-4o", provider: "openai" }),
		};

		await command?.handler("openai/gpt-4o", {
			ui: { notify, select: vi.fn() },
			model: { provider: "anthropic", id: "claude-sonnet-4" },
			modelRegistry: registry,
		} as never);

		expect(state.modelOverride).toBe("openai/gpt-4o");
		expect(state.applyMode).toHaveBeenCalled();
		expect(state.persistState).toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("Model override set: openai/gpt-4o", "success");
	});

	it("rejects unavailable model override", async () => {
		const mock = createMockPi();
		const notify = vi.fn();
		const state = {
			currentMode: "kuafu" as Mode,
			modelOverride: undefined,
			loadConfig: vi.fn(() => ({ body: "build", model: "anthropic/claude-opus-4" })),
			applyMode: vi.fn(async () => {}),
			persistState: vi.fn(),
		};

		registerModeCommands(mock.pi as never, state as unknown as ModeStateManager);
		const command = mock.commands.get("mode-model");

		await command?.handler("nonexistent-model", {
			ui: { notify, select: vi.fn() },
			model: undefined,
			modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined },
		} as never);

		expect(state.modelOverride).toBeUndefined();
		expect(state.applyMode).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith('Model not available: "nonexistent-model"', "error");
	});

	it("clears model override with --reset", async () => {
		const mock = createMockPi();
		const notify = vi.fn();
		const state = {
			currentMode: "kuafu" as Mode,
			modelOverride: "openai/gpt-4o" as string | undefined,
			loadConfig: vi.fn(() => ({ body: "build", model: "anthropic/claude-opus-4" })),
			applyMode: vi.fn(async () => {}),
			persistState: vi.fn(),
		};

		registerModeCommands(mock.pi as never, state as unknown as ModeStateManager);
		const command = mock.commands.get("mode-model");

		await command?.handler("--reset", {
			ui: { notify, select: vi.fn() },
			model: undefined,
			modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined },
		} as never);

		expect(state.modelOverride).toBeUndefined();
		expect(state.applyMode).toHaveBeenCalled();
		expect(state.persistState).toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("Model override cleared", "success");
	});
});
