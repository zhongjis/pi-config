import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-coding-agent", () => ({
	CustomEditor: class {
		handleInput(): void {}
		getText(): string {
			return "";
		}
	},
}));

vi.mock("@mariozechner/pi-tui", () => ({
	Key: { tab: "tab" },
	matchesKey: () => false,
}));

vi.mock("../src/config-loader.js", () => ({
	loadAgentConfig: () => ({ body: "" }),
}));

vi.mock("../src/plan-storage.js", () => ({
	derivePlanTitleFromMarkdown: (content: string) => {
		const match = content.match(/^#\s+(.+)$/mu);
		return match?.[1]?.trim();
	},
	hydratePlanState: vi.fn(async () => undefined),
}));

vi.mock("../src/plan-local.js", () => ({
	LOCAL_PLAN_URI: "local://PLAN.md",
	getLocalPlanPath: () => "/repo/PLAN.md",
	readLocalPlanFile: vi.fn(async () => "# Plan\n"),
}));

vi.mock("../src/plannotator.js", () => ({
	promptPostPlanAction: vi.fn(async () => undefined),
	recoverPlanReview: vi.fn(async () => undefined),
}));

import {
	createSuccessReply,
	HANDOFF_GET_CHANNEL,
	HANDOFF_MARK_CONSUMED_CHANNEL,
} from "../../handoff/src/protocol.js";
import type { HandoffReadiness } from "../../handoff/src/types.js";
import { registerModeHooks } from "../src/hooks.js";
import { ModeStateManager } from "../src/mode-state.js";

type LifecycleHandler = (event: unknown, ctx: any) => unknown | Promise<unknown>;
type EventHandler = (data: unknown) => unknown | Promise<unknown>;

function createMockPi(flagValue?: string) {
	const lifecycleHandlers = new Map<string, LifecycleHandler[]>();
	const eventHandlers = new Map<string, EventHandler[]>();
	const entries: Array<{ customType: string; data: unknown }> = [];

	const pi = {
		appendEntry: vi.fn((customType: string, data: unknown) => {
			entries.push({ customType, data });
		}),
		getAllTools: vi.fn(() => []),
		setActiveTools: vi.fn(),
		setModel: vi.fn(async () => undefined),
		getFlag: vi.fn((name: string) => (name === "mode" ? flagValue : undefined)),
		sendUserMessage: vi.fn(),
		on(event: string, handler: LifecycleHandler) {
			const handlers = lifecycleHandlers.get(event) ?? [];
			handlers.push(handler);
			lifecycleHandlers.set(event, handlers);
		},
		events: {
			emit(channel: string, data: unknown) {
				for (const handler of [...(eventHandlers.get(channel) ?? [])]) {
					void handler(data);
				}
			},
			on(channel: string, handler: EventHandler) {
				const handlers = eventHandlers.get(channel) ?? [];
				handlers.push(handler);
				eventHandlers.set(channel, handlers);
				return () => {
					eventHandlers.set(channel, (eventHandlers.get(channel) ?? []).filter((entry) => entry !== handler));
				};
			},
		},
	};

	return {
		entries,
		pi,
		onEvent(channel: string, handler: EventHandler) {
			return pi.events.on(channel, handler);
		},
		emitEvent(channel: string, data: unknown) {
			pi.events.emit(channel, data);
		},
		async fireLifecycle(event: string, payload: unknown, ctx: any) {
			const results: unknown[] = [];
			for (const handler of lifecycleHandlers.get(event) ?? []) {
				results.push(await handler(payload, ctx));
			}
			return results;
		},
	};
}

function createCtx(entries: unknown[] = []) {
	return {
		hasUI: true,
		hasPendingMessages: () => false,
		modelRegistry: { find: () => undefined, getAll: () => [] },
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			getSessionId: () => "session-1",
			getCwd: () => "/repo",
		},
		ui: {
			notify: vi.fn(),
			setEditorComponent: vi.fn(),
			setStatus: vi.fn(),
		},
	};
}

function createReadyReadiness(handoffId: string): HandoffReadiness {
	return {
		state: "ready",
		ready: true,
		handoffId,
		handoffStatus: "pending",
		storedPlanHash: "plan-hash",
		latestPlanHash: "plan-hash",
		planTitle: "Plan",
	};
}

describe("modes Hou Tu handoff flow", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("replaces stale mode prompt content when the target mode uses prompt_mode=replace", async () => {
		const mock = createMockPi();
		const ctx = createCtx();
		const state = new ModeStateManager(mock.pi as never);
		state.cachedConfigs.kuafu = { body: "Kua Fu prompt", promptMode: "replace" };
		state.cachedConfigs.houtu = { body: "Hou Tu prompt", promptMode: "replace" };
		state.currentMode = "houtu";
		registerModeHooks(mock.pi as never, state);

		const results = await mock.fireLifecycle(
			"before_agent_start",
			{ systemPrompt: "base instructions\n\nKua Fu prompt\n\nKua Fu prompt" },
			ctx,
		);

		expect(results[0]).toEqual({ systemPrompt: "base instructions\n\nHou Tu prompt" });
	});

	it("injects handoff context exactly once, preserves execution context, and consumes on success", async () => {
		const mock = createMockPi();
		const ctx = createCtx();
		const state = new ModeStateManager(mock.pi as never);
		state.cachedConfigs.houtu = { body: "" };
		state.currentMode = "houtu";
		state.pendingExecutionHandoffId = "handoff-2";
		registerModeHooks(mock.pi as never, state);

		let consumedCalls = 0;
		mock.onEvent(HANDOFF_GET_CHANNEL, (raw) => {
			const { requestId } = raw as { requestId: string };
			mock.emitEvent(
				`${HANDOFF_GET_CHANNEL}:reply:${requestId}`,
				createSuccessReply({
					authority: {
						handoffId: "handoff-2",
						status: "pending",
						producerMode: "fuxi",
						targetMode: "houtu",
						kickoffPrompt: "unused",
						createdAt: "2026-04-11T00:00:00.000Z",
						planHash: "plan-hash",
						planTitle: "Plan",
						planUri: "local://PLAN.md",
						briefingUri: "local://HANDOFF.md",
						authorityUri: "local://HANDOFF.json",
					},
					briefing: "Execute the approved plan in Hou Tu.",
					readiness: createReadyReadiness("handoff-2"),
				}),
			);
		});
		mock.onEvent(HANDOFF_MARK_CONSUMED_CHANNEL, (raw) => {
			const { requestId } = raw as { requestId: string };
			consumedCalls += 1;
			mock.emitEvent(
				`${HANDOFF_MARK_CONSUMED_CHANNEL}:reply:${requestId}`,
				createSuccessReply({
					authority: { handoffId: "handoff-2", status: "consumed" },
					readiness: {
						state: "not-ready",
						ready: false,
						reason: "Handoff status is consumed.",
						handoffId: "handoff-2",
						handoffStatus: "consumed",
					},
				}),
			);
		});

		const firstBeforeStart = await mock.fireLifecycle("before_agent_start", { systemPrompt: "system" }, ctx);
		expect(firstBeforeStart[0]).toMatchObject({
			message: {
				customType: "handoff-context",
				content: "Execute the approved plan in Hou Tu.",
				display: true,
			},
		});

		const secondBeforeStart = await mock.fireLifecycle("before_agent_start", { systemPrompt: "system" }, ctx);
		expect(secondBeforeStart[0]).toBeUndefined();

		const contextResults = await mock.fireLifecycle(
			"context",
			{
				messages: [
					{ role: "user", content: "old planning chatter" },
					{ customType: "plan-mode-context", content: "drop me" },
					{ customType: "handoff-context", content: "keep me" },
					{ role: "assistant", content: "execution message" },
				],
			},
			ctx,
		);
		expect(contextResults[0]).toEqual({
			messages: [
				{ customType: "handoff-context", content: "keep me" },
				{ role: "assistant", content: "execution message" },
			],
		});

		await mock.fireLifecycle("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		expect(consumedCalls).toBe(1);
		expect(state.pendingExecutionHandoffId).toBeUndefined();
		expect(state.activeInjectedHandoffId).toBeUndefined();
	});

	it("switches back to Fu Xi when pending handoff is invalid", async () => {
		const mock = createMockPi();
		const ctx = createCtx();
		const state = new ModeStateManager(mock.pi as never);
		state.cachedConfigs.houtu = { body: "" };
		state.cachedConfigs.fuxi = { body: "Fu Xi prompt", promptMode: "replace" };
		state.currentMode = "houtu";
		state.pendingExecutionHandoffId = "handoff-bad";
		registerModeHooks(mock.pi as never, state);

		mock.onEvent(HANDOFF_GET_CHANNEL, (raw) => {
			const { requestId } = raw as { requestId: string };
			mock.emitEvent(
				`${HANDOFF_GET_CHANNEL}:reply:${requestId}`,
				createSuccessReply({
					authority: undefined,
					readiness: {
						state: "missing",
						ready: false,
						reason: "Execution handoff handoff-bad no longer has persisted authority.",
						handoffId: "handoff-bad",
					},
				}),
			);
		});

		const results = await mock.fireLifecycle("before_agent_start", { systemPrompt: "system" }, ctx);
		expect(state.currentMode).toBe("fuxi");
		expect(state.planActionPending).toBe(true);
		expect(state.pendingExecutionHandoffId).toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Execution handoff handoff-bad no longer has persisted authority. Switched back to Fu Xi. Retry Hou Tu handoff from latest finalized plan.",
			"warning",
		);
		expect(results[0]).toBeUndefined();
	});

	it("does not consume a handoff after an aborted terminal turn", async () => {
		const mock = createMockPi();
		const ctx = createCtx();
		const state = new ModeStateManager(mock.pi as never);
		state.cachedConfigs.houtu = { body: "" };
		state.currentMode = "houtu";
		state.pendingExecutionHandoffId = "handoff-3";
		state.activeInjectedHandoffId = "handoff-3";
		registerModeHooks(mock.pi as never, state);

		let consumedCalls = 0;
		mock.onEvent(HANDOFF_MARK_CONSUMED_CHANNEL, () => {
			consumedCalls += 1;
		});

		await mock.fireLifecycle("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] }, ctx);
		expect(consumedCalls).toBe(0);
		expect(state.pendingExecutionHandoffId).toBe("handoff-3");
		expect(state.activeInjectedHandoffId).toBeUndefined();
	});

	it("does not consume a handoff after an errored terminal turn", async () => {
		const mock = createMockPi();
		const ctx = createCtx();
		const state = new ModeStateManager(mock.pi as never);
		state.cachedConfigs.houtu = { body: "" };
		state.currentMode = "houtu";
		state.pendingExecutionHandoffId = "handoff-4";
		state.activeInjectedHandoffId = "handoff-4";
		registerModeHooks(mock.pi as never, state);

		let consumedCalls = 0;
		mock.onEvent(HANDOFF_MARK_CONSUMED_CHANNEL, () => {
			consumedCalls += 1;
		});

		await mock.fireLifecycle("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] }, ctx);
		expect(consumedCalls).toBe(0);
		expect(state.pendingExecutionHandoffId).toBe("handoff-4");
		expect(state.activeInjectedHandoffId).toBeUndefined();
	});
});
