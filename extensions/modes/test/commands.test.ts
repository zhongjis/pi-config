import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-tui", () => ({
	Key: { ctrlShift: (key: string) => `ctrl+shift+${key}` },
}));

import { registerModeCommands } from "../src/commands.js";
import type { ModeStateManager } from "../src/mode-state.js";
import type { Mode } from "../src/types.js";

interface RegisteredCommand {
	description: string;
	handler: (args: string, ctx: { ui: { select: ReturnType<typeof vi.fn> } }) => Promise<void>;
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
			cycleMode: vi.fn(async () => {}),
		};

		registerModeCommands(mock.pi as never, state as unknown as ModeStateManager);

		const modeCommand = mock.commands.get("mode");
		expect(modeCommand).toBeDefined();

		const select = vi.fn(async (_title: string, items: string[]) => items[3]);
		await modeCommand?.handler("", { ui: { select } });

		expect(select).toHaveBeenCalledWith("Agent Mode", expect.any(Array));
		expect(state.switchMode).toHaveBeenCalledWith("luban", { ui: { select } });
	});
});
