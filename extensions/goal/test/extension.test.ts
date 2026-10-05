import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { goalFilePath, readGoal } from "../src/goal/store.js";
import type { GoalStoreRef } from "../src/goal/types.js";
import { goalFooterIndicator } from "../src/goal/ui.js";
import piGoalExtension from "../src/index.js";

type ToolResult = AgentToolResult<unknown>;

type GoalContext = {
	hasUI: boolean;
	signal?: AbortSignal;
	ui: MockUi;
	cwd: string;
	sessionManager: {
		getSessionFile(): string;
		getSessionDir(): string;
		getSessionId(): string;
	};
	isIdle(): boolean;
	hasPendingMessages(): boolean;
};

type RegisteredTool = {
	name: string;
	description: string;
	parameters: unknown;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: GoalContext,
	): Promise<ToolResult>;
};

type RegisteredCommand = {
	handler(args: string, ctx: GoalContext): Promise<void>;
};

type EventPayload = {
	type: string;
	reason?: string;
	messages?: unknown[];
};

type EventHandler = (event: EventPayload, ctx: GoalContext) => unknown | Promise<unknown>;

type NotifyType = "info" | "warning" | "error";
type SelectCall = { title: string; options: string[] };
type ConfirmCall = { title: string; message: string };
type NotifyCall = { message: string; type: NotifyType | undefined };
type MockUi = {
	selectCalls: SelectCall[];
	confirmCalls: ConfirmCall[];
	notifyCalls: NotifyCall[];
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, type?: NotifyType): void;
	setWidget(key: string, content: string[] | undefined): void;
	setStatus(key: string, text: string | undefined): void;
	setFooter(factory: unknown): void;
};
type SentMessage = {
	message: { customType: string; content: string; display: boolean };
	options: Record<string, unknown>;
};

const tempDirs: string[] = [];

let mockedClockMilliseconds: number | null = null;

// Bun's setSystemTime treats an epoch-0 Date as "reset to real time", so the
// fake clock is anchored at 2020-01-01T00:00:00Z and advanced from there.
const CLOCK_EPOCH_MILLISECONDS = 1_577_836_800_000;

function setClock(milliseconds: number): void {
	mockedClockMilliseconds = milliseconds;
	if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(CLOCK_EPOCH_MILLISECONDS + milliseconds));
}

function advanceClock(milliseconds: number): void {
	setClock((mockedClockMilliseconds ?? 0) + milliseconds);
}

function resetClock(): void {
	mockedClockMilliseconds = null;
	vi.useRealTimers();
}

describe("pi-goal extension tool contract", () => {
	it("exposes the goal tool names and parameter schemas", () => {
		const harness = createHarness();

		const getGoal = harness.tool("get_goal");
		expect(getGoal.name).toBe("get_goal");
		expect(getGoal.parameters).toMatchObject({
			type: "object",
			properties: {},
			additionalProperties: false,
		});

		const createGoal = harness.tool("create_goal");
		expect(createGoal.name).toBe("create_goal");
		expect(createGoal.parameters).toMatchObject({
			type: "object",
			required: ["objective"],
			properties: {
				objective: { type: "string" },
				token_budget: { type: "integer" },
			},
			additionalProperties: false,
		});

		const updateGoal = harness.tool("update_goal");
		expect(updateGoal.name).toBe("update_goal");
		expect(updateGoal.parameters).toMatchObject({
			type: "object",
			required: ["status"],
			properties: {
				status: {
					anyOf: [
						{ type: "string", const: "complete" },
						{ type: "string", const: "blocked" },
					],
				},
			},
			additionalProperties: false,
		});
	});
});

describe("pi-goal extension accounting", () => {
	afterEach(async () => {
		resetClock();
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("requires blocked reasons and refuses model updates after explicit pause", async () => {
		const harness = createHarness();
		const ctx = await createContext("thread-model-guards");
		await harness.tool("create_goal").execute("create", { objective: "Approval" }, undefined, undefined, ctx);
		await expect(
			harness.tool("update_goal").execute("block", { status: "blocked" }, undefined, undefined, ctx),
		).rejects.toThrow("nonempty");
		await harness
			.tool("update_goal")
			.execute("block", { status: "blocked", blockedReason: "  Approval unavailable  " }, undefined, undefined, ctx);
		expect(toolResultText(await harness.tool("get_goal").execute("get", {}, undefined, undefined, ctx))).toContain(
			'"blockedReason": "Approval unavailable"',
		);
		await harness.command("goal").handler("pause", ctx);
		await expect(
			harness.tool("update_goal").execute("complete", { status: "complete" }, undefined, undefined, ctx),
		).rejects.toThrow("model may only");
		expect(await readGoal(refForContext(ctx))).toMatchObject({ status: "paused" });
	});

	it("does not let an old model turn complete a user replacement", async () => {
		const harness = createHarness();
		const ctx = await createContext("thread-replaced-model");
		await harness.tool("create_goal").execute("create", { objective: "Original" }, undefined, undefined, ctx);
		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		await harness.command("goal").handler("Replacement", ctx);
		const result = await harness
			.tool("update_goal")
			.execute("complete", { status: "complete" }, undefined, undefined, ctx);
		expect(toolResultText(result)).toContain("goal changed");
		await harness.emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", usage: { input: 9 } }] }, ctx);
		expect(await readGoal(refForContext(ctx))).toMatchObject({
			objective: "Replacement",
			status: "active",
			tokensUsed: 0,
		});
	});

	it("finalizes aborted usage without replacing pause with budgetLimited", async () => {
		const harness = createHarness();
		const ctx = await createContext("thread-aborted-budget");
		const controller = new AbortController();
		ctx.signal = controller.signal;
		await harness
			.tool("create_goal")
			.execute("create", { objective: "Budget work", token_budget: 1 }, undefined, undefined, ctx);
		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		controller.abort();
		await harness.emit(
			"agent_end",
			{ type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted", usage: { input: 10, output: 2 } }] },
			ctx,
		);
		expect(await readGoal(refForContext(ctx))).toMatchObject({ status: "paused", tokensUsed: 12 });
		expect(harness.sentMessages).toHaveLength(0);
	});

	it("starts elapsed-time accounting when a goal is created during an active agent turn", async () => {
		setClock(0);
		const harness = createHarness();
		const ctx = await createContext("thread-create-during-turn");

		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		advanceClock(30_000);
		await harness
			.tool("create_goal")
			.execute("create-goal", { objective: "created after the turn started" }, undefined, undefined, ctx);
		advanceClock(10_000);

		await harness.emit("agent_end", { type: "agent_end", messages: [] }, ctx);

		const goal = await readGoal(refForContext(ctx));
		expect(goal?.timeUsedSeconds).toBe(10);
	});

	it("accounts resumed active goal time from session start without counting offline time", async () => {
		setClock(0);
		const harness = createHarness();
		const ctx = await createContext("thread-resume-active-accounting");

		// given
		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		await harness.tool("create_goal").execute("create-goal", { objective: "Resume work" }, undefined, undefined, ctx);
		advanceClock(20_000);
		await harness.emit("agent_end", { type: "agent_end", messages: [] }, ctx);
		await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx);
		advanceClock(80_000);

		// when
		await harness.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
		advanceClock(7_000);
		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		advanceClock(11_000);
		await harness.emit("agent_end", { type: "agent_end", messages: [] }, ctx);

		// then
		const goal = await readGoal(refForContext(ctx));
		expect(goal?.timeUsedSeconds).toBe(38);
	});

	it("finalizes elapsed time and usage when update_goal completes an active turn", async () => {
		setClock(0);
		const harness = createHarness();
		const ctx = await createContext("thread-complete-during-turn");

		await harness
			.tool("create_goal")
			.execute("create-goal", { objective: "finish in this turn" }, undefined, undefined, ctx);
		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		advanceClock(65_000);

		const completion = await harness
			.tool("update_goal")
			.execute("complete-goal", { status: "complete" }, undefined, undefined, ctx);

		const completedGoal = await readGoal(refForContext(ctx));
		expect(completedGoal?.status).toBe("complete");
		expect(completedGoal?.timeUsedSeconds).toBe(65);
		expect(completedGoal === null ? "" : goalFooterIndicator(completedGoal).text).toBe("Goal achieved (1m)");
		expect(toolResultText(completion)).toContain('"timeUsedSeconds": 65');

		advanceClock(5_000);
		await harness.emit(
			"agent_end",
			{
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						usage: { input: 100, output: 20, cacheRead: 60, cacheWrite: 0, totalTokens: 120 },
					},
				],
			},
			ctx,
		);

		const finalizedGoal = await readGoal(refForContext(ctx));
		expect(finalizedGoal?.tokensUsed).toBe(120);
		expect(finalizedGoal?.timeUsedSeconds).toBe(70);
	});

	it("does not check pending messages after a goal completes", async () => {
		const harness = createHarness();
		const ctx = await createContext("thread-complete-with-stale-pending");

		await harness
			.tool("create_goal")
			.execute("create-goal", { objective: "finish without continuation checks" }, undefined, undefined, ctx);
		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		await harness.tool("update_goal").execute("complete-goal", { status: "complete" }, undefined, undefined, ctx);
		ctx.hasPendingMessages = () => {
			throw new Error("stale pending messages");
		};

		await expect(harness.emit("agent_end", { type: "agent_end", messages: [] }, ctx)).resolves.toBeUndefined();
	});

	it("does not fail completed accounting when the UI ctx is stale", async () => {
		const harness = createHarness();
		const ctx = await createContext("thread-complete-with-stale-ui");

		await harness
			.tool("create_goal")
			.execute("create-goal", { objective: "finish with stale ui" }, undefined, undefined, ctx);
		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		await harness.tool("update_goal").execute("complete-goal", { status: "complete" }, undefined, undefined, ctx);
		Object.defineProperty(ctx, "hasUI", {
			get() {
				throw new Error("This extension ctx is stale after session replacement or reload.");
			},
		});

		await expect(
			harness.emit(
				"agent_end",
				{
					type: "agent_end",
					messages: [
						{
							role: "assistant",
							usage: { input: 100, output: 20, cacheRead: 60, cacheWrite: 0, totalTokens: 120 },
						},
					],
				},
				ctx,
			),
		).resolves.toBeUndefined();

		const goal = await readGoal(refForContext(ctx));
		expect(goal?.tokensUsed).toBe(120);
	});

	it("does not reread goal state during shutdown when no accounting is active", async () => {
		const harness = createHarness();
		const ctx = await createContext("thread-shutdown-no-accounting");
		const filePath = goalFilePath(refForContext(ctx));
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, "", "utf8");

		await expect(harness.emit("session_shutdown", { type: "session_shutdown" }, ctx)).resolves.toBeUndefined();
	});

	it("does not touch stale shutdown ctx when no accounting is active", async () => {
		const harness = createHarness();
		const ctx = await createContext("thread-shutdown-stale-ctx");
		Object.defineProperty(ctx, "hasUI", {
			get() {
				throw new Error("stale ctx");
			},
		});

		await expect(harness.emit("session_shutdown", { type: "session_shutdown" }, ctx)).resolves.toBeUndefined();
	});
});

describe("pi-goal extension command UI parity", () => {
	afterEach(async () => {
		resetClock();
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("shows Codex-style usage text for a bare /goal without a goal", async () => {
		const harness = createHarness();
		const ui = createMockUi();
		const ctx = await createContext("thread-show-no-goal", { hasUI: true, ui });

		await harness.command("goal").handler("", ctx);

		expect(ui.notifyCalls).toContainEqual({
			message: "Usage: /goal <objective>\nNo goal is currently set.",
			type: "warning",
		});
	});

	it("confirms a fresh goal minimally while keeping full inspection available", async () => {
		const harness = createHarness();
		const ui = createMockUi();
		const ctx = await createContext("thread-start-confirmation", { hasUI: true, ui });

		await harness.command("goal").handler("Fresh work", ctx);

		expect(ui.notifyCalls).toEqual([{ message: "Goal started\nObjective: Fresh work", type: "info" }]);
		await harness.command("goal").handler("", ctx);
		expect(ui.notifyCalls.at(-1)?.message).toBe("Objective: Fresh work\nStatus: active\nTime used: 0s\nTokens used: 0");
	});

	it.each([
		"Budget work",
		"resume",
	])("retains accumulated usage and budget when resuming via /goal %s", async (args) => {
		setClock(0);
		const harness = createHarness();
		const ui = createMockUi({ selectResponses: ["Replace current goal"] });
		const ctx = await createContext(`thread-usage-resume-${args}`, { hasUI: true, ui });
		await harness
			.tool("create_goal")
			.execute("create-goal", { objective: "Budget work", token_budget: 1000 }, undefined, undefined, ctx);
		const original = await readGoal(refForContext(ctx));
		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		advanceClock(65_000);
		await harness.emit(
			"agent_end",
			{ type: "agent_end", messages: [{ role: "assistant", usage: { input: 100, output: 20 } }] },
			ctx,
		);
		await harness.command("goal").handler("pause", ctx);
		expect(ui.notifyCalls.at(-1)?.message).toContain("Time used: 1m\nTokens used: 120/1K");

		await harness.command("goal").handler(args, ctx);

		expect(await readGoal(refForContext(ctx))).toMatchObject({ id: original?.id, status: "active" });
		expect(ui.notifyCalls.at(-1)?.message).toContain("Goal active\nObjective: Budget work");
		expect(ui.notifyCalls.at(-1)?.message).toContain("Status: active\nTime used: 1m\nTokens used: 120/1K");
		await harness.command("goal").handler("", ctx);
		expect(ui.notifyCalls.at(-1)?.message).toBe(
			"Objective: Budget work\nStatus: active\nTime used: 1m\nTokens used: 120/1K",
		);
	});

	it("shows Codex-style clear feedback when no goal exists", async () => {
		const harness = createHarness();
		const ui = createMockUi();
		const ctx = await createContext("thread-clear-no-goal", { hasUI: true, ui });

		await harness.command("goal").handler("clear", ctx);

		expect(ui.notifyCalls).toContainEqual({
			message: "No goal to clear\nThis thread does not currently have a goal.",
			type: "warning",
		});
	});

	it("asks with Codex-style choices before replacing an existing goal", async () => {
		const harness = createHarness();
		const ui = createMockUi({ selectResponses: ["Cancel"] });
		const ctx = await createContext("thread-replace-cancel", { hasUI: true, ui });
		await harness.tool("create_goal").execute("create-goal", { objective: "Original" }, undefined, undefined, ctx);

		await harness.command("goal").handler("Replacement", ctx);

		expect(ui.selectCalls).toContainEqual({
			title: "Replace goal?\nNew objective: Replacement",
			options: ["Replace current goal", "Cancel"],
		});
		expect(ui.confirmCalls).toHaveLength(0);
		expect(await readGoal(refForContext(ctx))).toMatchObject({ objective: "Original" });
	});

	it("replaces an existing goal only after the replace choice is selected", async () => {
		const harness = createHarness();
		const ui = createMockUi({ selectResponses: ["Replace current goal"] });
		const ctx = await createContext("thread-replace-confirm", { hasUI: true, ui });
		await harness.tool("create_goal").execute("create-goal", { objective: "Original" }, undefined, undefined, ctx);

		await harness.command("goal").handler("Replacement", ctx);

		expect(await readGoal(refForContext(ctx))).toMatchObject({
			objective: "Replacement",
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
		});
		expect(ui.notifyCalls.at(-1)).toMatchObject({
			message: "Goal started\nObjective: Replacement",
			type: "info",
		});
	});

	it("keeps a reopened goal paused without a resume dialog", async () => {
		const harness = createHarness();
		const ui = createMockUi({ selectResponses: ["Resume goal"] });
		const ctx = await createContext("thread-resume-paused", { hasUI: true, ui });
		await harness.tool("create_goal").execute("create-goal", { objective: "Paused work" }, undefined, undefined, ctx);
		await harness.command("goal").handler("pause", ctx);

		await harness.emit("session_start", { type: "session_start", reason: "resume" }, ctx);

		expect(ui.selectCalls).toHaveLength(0);
		expect(await readGoal(refForContext(ctx))).toMatchObject({ objective: "Paused work", status: "paused" });
		expect(harness.sentMessages).toHaveLength(0);
	});

	it("does not prompt to resume a paused goal on non-resume session starts", async () => {
		const harness = createHarness();
		const ui = createMockUi({ selectResponses: ["Resume goal"] });
		const ctx = await createContext("thread-startup-paused", { hasUI: true, ui });
		await harness.tool("create_goal").execute("create-goal", { objective: "Paused work" }, undefined, undefined, ctx);
		await harness.command("goal").handler("pause", ctx);

		await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ui.selectCalls).toHaveLength(0);
		expect(await readGoal(refForContext(ctx))).toMatchObject({ objective: "Paused work", status: "paused" });
		expect(harness.sentMessages).toHaveLength(0);
	});

	it("leaves a paused resumed-session goal paused when that choice is selected", async () => {
		const harness = createHarness();
		const ui = createMockUi({ selectResponses: ["Leave paused"] });
		const ctx = await createContext("thread-leave-paused", { hasUI: true, ui });
		await harness.tool("create_goal").execute("create-goal", { objective: "Paused work" }, undefined, undefined, ctx);
		await harness.command("goal").handler("pause", ctx);

		await harness.emit("session_start", { type: "session_start", reason: "resume" }, ctx);

		expect(await readGoal(refForContext(ctx))).toMatchObject({ objective: "Paused work", status: "paused" });
		expect(harness.sentMessages).toHaveLength(0);
	});
});

function createHarness(): {
	tool(name: string): RegisteredTool;
	command(name: string): RegisteredCommand;
	emit(event: string, payload: EventPayload, ctx: GoalContext): Promise<void>;
	sentMessages: SentMessage[];
} {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, RegisteredCommand>();
	const handlers = new Map<string, EventHandler[]>();
	const sentMessages: SentMessage[] = [];

	piGoalExtension(createExtensionApi(tools, commands, handlers, sentMessages));

	return {
		tool(name) {
			const tool = tools.get(name);
			if (tool === undefined) throw new Error(`tool not registered: ${name}`);
			return tool;
		},
		command(name) {
			const command = commands.get(name);
			if (command === undefined) throw new Error(`command not registered: ${name}`);
			return command;
		},
		async emit(event, payload, ctx) {
			for (const handler of handlers.get(event) ?? []) {
				await handler(payload, ctx);
			}
		},
		sentMessages,
	};
}

function createExtensionApi(
	tools: Map<string, RegisteredTool>,
	commands: Map<string, RegisteredCommand>,
	handlers: Map<string, EventHandler[]>,
	sentMessages: SentMessage[],
): ExtensionAPI {
	return {
		on(event, handler) {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push((payload, ctx) => handler(payload as never, ctx as never));
			handlers.set(event, eventHandlers);
		},
		registerTool(tool) {
			tools.set(tool.name, {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				execute(toolCallId, params, signal, onUpdate, ctx) {
					return tool.execute(toolCallId, params as never, signal, onUpdate, ctx as never);
				},
			});
		},
		registerCommand(name, options) {
			commands.set(name, {
				handler(args, ctx) {
					return options.handler(args, ctx as never);
				},
			});
		},
		registerShortcut() {},
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		registerMessageRenderer() {},
		sendMessage(message, options) {
			sentMessages.push({
				message: {
					customType: message.customType,
					content: String(message.content),
					display: message.display,
				},
				options: options ?? {},
			});
		},
		sendUserMessage() {},
		appendEntry() {},
		setSessionName() {},
		getSessionName() {
			return undefined;
		},
		setLabel() {},
		async exec() {
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
		getActiveTools() {
			return [];
		},
		getAllTools() {
			return [];
		},
		setActiveTools() {},
		getCommands() {
			return [];
		},
		async setModel() {
			return false;
		},
		getThinkingLevel() {
			return "medium";
		},
		setThinkingLevel() {},
		registerProvider() {},
		unregisterProvider() {},
		events: {
			emit() {},
			on() {
				return () => {};
			},
		},
	};
}

type ContextOptions = {
	hasUI?: boolean;
	ui?: MockUi;
	isIdle?: boolean;
	hasPendingMessages?: boolean;
};

async function createContext(threadId: string, options: ContextOptions = {}): Promise<GoalContext> {
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-goal-extension-"));
	tempDirs.push(sessionDir);
	return {
		hasUI: options.hasUI ?? false,
		ui: options.ui ?? createMockUi(),
		cwd: sessionDir,
		sessionManager: {
			getSessionFile: () => join(sessionDir, "session.json"),
			getSessionDir: () => sessionDir,
			getSessionId: () => threadId,
		},
		isIdle: () => options.isIdle ?? true,
		hasPendingMessages: () => options.hasPendingMessages ?? false,
	};
}

function createMockUi(
	options: { selectResponses?: (string | undefined)[]; confirmResponses?: boolean[] } = {},
): MockUi {
	const selectResponses = [...(options.selectResponses ?? [])];
	const confirmResponses = [...(options.confirmResponses ?? [])];
	return {
		selectCalls: [],
		confirmCalls: [],
		notifyCalls: [],
		async select(title, choices) {
			this.selectCalls.push({ title, options: choices });
			return selectResponses.shift();
		},
		async confirm(title, message) {
			this.confirmCalls.push({ title, message });
			return confirmResponses.shift() ?? false;
		},
		notify(message, type) {
			this.notifyCalls.push({ message, type });
		},
		setWidget() {},
		setStatus() {},
		setFooter() {},
	};
}

function refForContext(ctx: GoalContext): GoalStoreRef {
	return {
		baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "goal"),
		threadId: ctx.sessionManager.getSessionId(),
	};
}

function toolResultText(result: ToolResult): string {
	const firstContent = result.content[0];
	if (firstContent?.type !== "text") throw new Error("tool result had no text content");
	return firstContent.text;
}
