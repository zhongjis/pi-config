import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const completeMock = vi.fn();

vi.mock("@mariozechner/pi-ai", () => ({
	complete: completeMock,
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
	BorderedLoader: class {
		signal = undefined;
		onAbort?: () => void;
		constructor(..._args: unknown[]) {}
	},
	convertToLlm: (messages: unknown) => messages,
	serializeConversation: (messages: unknown) => JSON.stringify(messages),
}));

type CommandDefinition = {
	description: string;
	handler: (args: string, ctx: any) => Promise<void> | void;
};

function createMockPi() {
	const commands = new Map<string, CommandDefinition>();
	const lifecycleHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<void> | void>>();
	const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
	const sendUserMessage = vi.fn();

	const events = {
		on(event: string, handler: (data: unknown) => void) {
			const handlers = eventHandlers.get(event) ?? [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
			return () => {
				const current = eventHandlers.get(event) ?? [];
				eventHandlers.set(
					event,
					current.filter((entry) => entry !== handler),
				);
			};
		},
		emit(event: string, data: unknown) {
			for (const handler of [...(eventHandlers.get(event) ?? [])]) {
				handler(data);
			}
		},
	};

	const pi = {
		registerCommand(name: string, command: CommandDefinition) {
			commands.set(name, command);
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
			const handlers = lifecycleHandlers.get(event) ?? [];
			handlers.push(handler);
			lifecycleHandlers.set(event, handlers);
		},
		sendUserMessage,
		events,
	};

	return {
		pi,
		sendUserMessage,
		async executeCommand(name: string, args: string, ctx: unknown) {
			const command = commands.get(name);
			if (!command) {
				throw new Error(`Command ${name} not registered`);
			}
			await command.handler(args, ctx);
		},
		async fireLifecycle(event: string, payload: unknown, ctx?: unknown) {
			for (const handler of lifecycleHandlers.get(event) ?? []) {
				await handler(payload, ctx);
			}
		},
	};
}

function createCommandContext(options: {
	summaryChoice?: string | null;
	currentModel?: { provider: string; id: string } | undefined;
	sessionFile?: string;
} = {}) {
	const appendedCustomEntries: Array<{ customType: string; data: unknown }> = [];
	let sessionReplaced = false;
	const ui = {
		notify: vi.fn((..._args: unknown[]) => {
			if (sessionReplaced) throw new Error("stale ctx notify");
		}),
		setEditorText: vi.fn((..._args: unknown[]) => {
			if (sessionReplaced) throw new Error("stale ctx editor");
		}),
		select: vi.fn(async () => options.summaryChoice ?? null),
		custom: vi.fn(async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: string | null) => void) => unknown) => {
			return await new Promise<string | null>((resolve) => {
				factory({}, {}, {}, resolve);
			});
		}),
	};
	const replacementUi = {
		notify: vi.fn(),
		setEditorText: vi.fn(),
	};

	const ctx = {
		hasUI: true,
		ui,
		model: options.currentModel,
		modelRegistry: {
			getAvailable: () => [{ provider: "anthropic", id: "claude-haiku-4-5" }],
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key", headers: {} })),
		},
		sessionManager: {
			getBranch: () => [
				{
					type: "message",
					message: {
						role: "user",
						content: [{ type: "text", text: "Please continue this work" }],
					},
				},
			],
			getSessionFile: () => options.sessionFile ?? "/repo/.pi/sessions/parent.jsonl",
		},
		waitForIdle: vi.fn(async () => {}),
		newSession: vi.fn(async ({
			setup,
			withSession,
		}: {
			setup?: (sessionManager: unknown) => Promise<void>;
			withSession?: (replacementCtx: unknown) => Promise<void>;
		}) => {
			await setup?.({
				appendCustomEntry: (customType: string, data: unknown) => appendedCustomEntries.push({ customType, data }),
			});
			sessionReplaced = true;
			await withSession?.({ hasUI: true, ui: replacementUi });
			return { cancelled: false };
		}),
	};

	return { ctx, ui, replacementUi, appendedCustomEntries };
}

async function initExtension(mock: ReturnType<typeof createMockPi>) {
	vi.resetModules();
	const { default: init } = await import("../index.js");
	init(mock.pi as never);
}

async function withTempHome(run: (tempHome: string) => Promise<void>) {
	const tempHome = await mkdtemp(join(tmpdir(), "handoff-home-"));
	const originalHome = process.env.HOME;
	process.env.HOME = tempHome;
	completeMock.mockReset();
	completeMock.mockResolvedValue({
		stopReason: "stop",
		content: [{ type: "text", text: "## Context\nSummary\n\n## Task\nProceed" }],
	});

	try {
		await run(tempHome);
	} finally {
		process.env.HOME = originalHome;
		await rm(tempHome, { recursive: true, force: true });
	}
}

describe("handoff extension", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("creates a child session and populates editor with deterministic prompt when summarization is disabled", async () => {
		await withTempHome(async () => {
			const mock = createMockPi();
			await initExtension(mock);
			const { ctx, ui, replacementUi, appendedCustomEntries } = createCommandContext();

			await mock.executeCommand("handoff", '-mode houtu -no-summarize "ship feature"', ctx);

			expect(ctx.newSession).toHaveBeenCalledTimes(1);
			expect(appendedCustomEntries).toEqual([{ customType: "agent-mode", data: { mode: "houtu" } }]);
			expect(ui.setEditorText).not.toHaveBeenCalled();
			expect(ui.notify).not.toHaveBeenCalled();
			expect(replacementUi.setEditorText).toHaveBeenCalledTimes(1);
			expect(replacementUi.setEditorText.mock.calls[0][0]).toContain("ship feature");
			expect(replacementUi.setEditorText.mock.calls[0][0]).toContain("Parent session");
			expect(replacementUi.notify).toHaveBeenCalledWith("Handoff ready. Press Enter to start.", "info");
			// sendUserMessage no longer used for prompt delivery
			expect(mock.sendUserMessage).not.toHaveBeenCalled();
		});
	});

	it("bridges prepared handoff requests into handoff:start-work without duplicate attempts", async () => {
		await withTempHome(async () => {
			const mock = createMockPi();
			await initExtension(mock);
			const runtime = await import("../runtime.js");
			const { ctx, replacementUi, appendedCustomEntries } = createCommandContext({ sessionFile: "/repo/.pi/sessions/plan.jsonl" });

			const reply = await runtime.requestDirectHandoffBridge(mock.pi as never, {
				sessionFile: "/repo/.pi/sessions/plan.jsonl",
				goal: "ship feature",
				mode: "houtu",
				summarize: false,
				source: "modes",
			});

			expect(reply).toEqual({
				success: true,
				data: {
					command: "/handoff:start-work",
					sessionFile: "/repo/.pi/sessions/plan.jsonl",
					source: "modes",
				},
			});

			await mock.executeCommand("handoff:start-work", "", ctx);

			expect(ctx.newSession).toHaveBeenCalledTimes(1);
			expect(appendedCustomEntries).toEqual([{ customType: "agent-mode", data: { mode: "houtu" } }]);
			expect(replacementUi.setEditorText).toHaveBeenCalledTimes(1);
			expect(replacementUi.setEditorText.mock.calls[0][0]).toContain("ship feature");
			// sendUserMessage no longer used for prompt delivery
			expect(mock.sendUserMessage).not.toHaveBeenCalled();
		});
	});

	it("summarizes with selected model and remembers the last summary model", async () => {
		await withTempHome(async (tempHome) => {
			const mock = createMockPi();
			await initExtension(mock);
			const { ctx, ui } = createCommandContext({ summaryChoice: "anthropic/claude-haiku-4-5" });

			await mock.executeCommand("handoff", "investigate auth flow", ctx);

			expect(ui.select).toHaveBeenCalledWith("Summary model", ["anthropic/claude-haiku-4-5"]);
			expect(completeMock).toHaveBeenCalledTimes(1);

			const saved = await readFile(join(tempHome, ".pi", "agent", "handoff.json"), "utf8");
			expect(saved).toContain("anthropic/claude-haiku-4-5");
		});
	});

	it("does not call setEditorText when ctx.hasUI is false", async () => {
		await withTempHome(async () => {
			const mock = createMockPi();
			await initExtension(mock);
			const { ctx, ui } = createCommandContext();
			(ctx as any).hasUI = false;

			await mock.executeCommand("handoff", '-mode kuafu -no-summarize "fix auth"', ctx);

			// hasUI is false → handoff should return early with error
			expect(ui.setEditorText).not.toHaveBeenCalled();
		});
	});

	it("does not call setEditorText when newSession is cancelled", async () => {
		await withTempHome(async () => {
			const mock = createMockPi();
			await initExtension(mock);
			const { ctx, ui } = createCommandContext();
			ctx.newSession = vi.fn(async () => ({ cancelled: true }));

			await mock.executeCommand("handoff", '-mode kuafu -no-summarize "fix auth"', ctx);

			expect(ui.setEditorText).not.toHaveBeenCalled();
		});
	});
});
