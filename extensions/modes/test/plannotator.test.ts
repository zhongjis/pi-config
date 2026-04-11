import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	hydratePlanState: vi.fn(async () => ({ content: "# Approved Plan\n\n- Ship it\n" })),
}));

vi.mock("../src/config-loader.js", () => ({
	loadAgentConfig: () => ({ body: "" }),
}));

vi.mock("../src/plan-local.js", () => ({
	LOCAL_PLAN_URI: "local://PLAN.md",
}));

vi.mock("../src/plan-storage.js", () => ({
	hydratePlanState: mocks.hydratePlanState,
}));

import {
	createErrorReply,
	createSuccessReply,
	HANDOFF_PREPARE_CHANNEL,
	HOUTU_EXECUTION_HANDOFF_SENTINEL_PREFIX,
} from "../../handoff/src/protocol.js";
import { ModeStateManager } from "../src/mode-state.js";
import { promptPostPlanAction } from "../src/plannotator.js";

const HANDOFF_TASK_CLEANUP_CHANNEL = "tasks:rpc:clear-planning-tasks";

type EventHandler = (data: unknown) => unknown | Promise<unknown>;

function createMockPi() {
	const eventHandlers = new Map<string, EventHandler[]>();

	const pi = {
		appendEntry: vi.fn(),
		getAllTools: vi.fn(() => []),
		setActiveTools: vi.fn(),
		setModel: vi.fn(async () => undefined),
		sendUserMessage: vi.fn(),
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
		pi,
		onEvent(channel: string, handler: EventHandler) {
			return pi.events.on(channel, handler);
		},
		emitEvent(channel: string, data: unknown) {
			pi.events.emit(channel, data);
		},
	};
}

function createCtx(selectResults: Array<string | undefined>) {
	const select = vi.fn(async () => selectResults.shift());
	const notify = vi.fn();
	const setStatus = vi.fn();

	return {
		ctx: {
			hasUI: true,
			modelRegistry: { find: () => undefined, getAll: () => [] },
			sessionManager: {
				getSessionId: () => "session-1",
			},
			ui: {
				select,
				notify,
				setStatus,
			},
		},
		ui: { select, notify, setStatus },
	};
}

function createState(pi: ReturnType<typeof createMockPi>["pi"]) {
	const state = new ModeStateManager(pi as never);
	state.currentMode = "fuxi";
	state.planTitle = "Approved Plan";
	state.planActionPending = true;
	state.planReviewApproved = true;
	state.highAccuracyReviewApproved = true;
	state.gapReviewApproved = true;
	return state;
}

describe("plannotator Execute in Hou Tu flow", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mocks.hydratePlanState.mockResolvedValue({ content: "# Approved Plan\n\n- Ship it\n" });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("switches to Hou Tu, keeps cleanup context, and queues the kickoff sentinel on success", async () => {
		const mock = createMockPi();
		const { ctx, ui } = createCtx(["Execute in Hou Tu"]);
		const state = createState(mock.pi);
		let cleanupRequest: { requestId: string; source: string; sessionId: string } | undefined;
		let prepareEnvelope:
			| {
				requestId: string;
				source?: string;
				payload: {
					handoffId: string;
					briefing: string;
					producerMode: string;
					targetMode: string;
					kickoffPrompt: string;
				};
			  }
			| undefined;

		mock.onEvent(HANDOFF_TASK_CLEANUP_CHANNEL, (raw) => {
			cleanupRequest = raw as { requestId: string; source: string; sessionId: string };
			mock.emitEvent(`${HANDOFF_TASK_CLEANUP_CHANNEL}:reply:${cleanupRequest.requestId}`, {
				success: true,
				data: { status: "cleared", removed: 2, removedIncomplete: 1 },
			});
		});
		mock.onEvent(HANDOFF_PREPARE_CHANNEL, (raw) => {
			prepareEnvelope = raw as NonNullable<typeof prepareEnvelope>;
			mock.emitEvent(
				`${HANDOFF_PREPARE_CHANNEL}:reply:${prepareEnvelope.requestId}`,
				createSuccessReply({
					authority: {
						handoffId: prepareEnvelope.payload.handoffId,
						kickoffPrompt: prepareEnvelope.payload.kickoffPrompt,
					},
				}),
			);
		});

		await promptPostPlanAction(mock.pi as never, state, ctx as never);
		await vi.runAllTimersAsync();

		expect(ui.select).toHaveBeenCalledWith(`Plan "Approved Plan" ready. What next?`, ["Execute in Hou Tu"]);
		expect(cleanupRequest).toMatchObject({
			source: "plan-execute-handoff",
			sessionId: "session-1",
		});
		expect(prepareEnvelope?.source).toBe("plan-execute-handoff");
		expect(prepareEnvelope?.payload.producerMode).toBe("fuxi");
		expect(prepareEnvelope?.payload.targetMode).toBe("houtu");
		expect(prepareEnvelope?.payload.kickoffPrompt).toMatch(
			new RegExp(`^${HOUTU_EXECUTION_HANDOFF_SENTINEL_PREFIX}`),
		);
		expect(prepareEnvelope?.payload.briefing).toContain("## Cleanup context");
		expect(prepareEnvelope?.payload.briefing).toContain(
			"Planning-task cleanup: cleared 2 planning tasks (1 incomplete).",
		);
		expect(state.currentMode).toBe("houtu");
		expect(state.planActionPending).toBe(false);
		expect(state.pendingExecutionHandoffId).toBe(prepareEnvelope?.payload.handoffId);
		expect(state.executionKickoffQueued).toBe(true);
		expect(state.justSwitchedToHoutu).toBe(true);
		expect(mock.pi.sendUserMessage).toHaveBeenCalledWith(prepareEnvelope?.payload.kickoffPrompt);
		expect(ui.notify).toHaveBeenCalledTimes(1);
		expect(ui.notify.mock.calls[0]?.[0]).toContain(
			"Planning-task cleanup: cleared 2 planning tasks (1 incomplete).",
		);
		expect(ui.notify.mock.calls[0]?.[0]).toContain(
			`Execution handoff prepared for Hou Tu (handoff ${prepareEnvelope?.payload.handoffId}).`,
		);
		expect(ui.notify.mock.calls[0]?.[1]).toBe("info");
	});

	it("stays in Fu Xi and reopens the post-plan menu when prepare fails", async () => {
		const mock = createMockPi();
		const { ctx, ui } = createCtx(["Execute in Hou Tu", undefined]);
		const state = createState(mock.pi);
		let prepareEnvelope:
			| {
				requestId: string;
				payload: { briefing: string };
			  }
			| undefined;

		mock.onEvent(HANDOFF_TASK_CLEANUP_CHANNEL, (raw) => {
			const request = raw as { requestId: string };
			mock.emitEvent(`${HANDOFF_TASK_CLEANUP_CHANNEL}:reply:${request.requestId}`, {
				success: true,
				data: { status: "already_clean" },
			});
		});
		mock.onEvent(HANDOFF_PREPARE_CHANNEL, (raw) => {
			prepareEnvelope = raw as NonNullable<typeof prepareEnvelope>;
			mock.emitEvent(
				`${HANDOFF_PREPARE_CHANNEL}:reply:${prepareEnvelope.requestId}`,
				createErrorReply(new Error("prepare exploded")),
			);
		});

		await promptPostPlanAction(mock.pi as never, state, ctx as never);
		await vi.runAllTimersAsync();

		expect(prepareEnvelope?.payload.briefing).toContain("Planning-task cleanup: no planning tasks needed cleanup.");
		expect(state.currentMode).toBe("fuxi");
		expect(state.planActionPending).toBe(true);
		expect(state.pendingExecutionHandoffId).toBeUndefined();
		expect(state.executionKickoffQueued).toBe(false);
		expect(mock.pi.setActiveTools).not.toHaveBeenCalled();
		expect(mock.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(ui.select).toHaveBeenCalledTimes(2);
		expect(ui.notify).toHaveBeenCalledTimes(1);
		expect(ui.notify.mock.calls[0]?.[0]).toContain("Planning-task cleanup: no planning tasks needed cleanup.");
		expect(ui.notify.mock.calls[0]?.[0]).toContain("Execution handoff could not be prepared: prepare exploded.");
		expect(ui.notify.mock.calls[0]?.[0]).toContain("Stayed in Fu Xi so you can retry from the post-plan menu.");
		expect(ui.notify.mock.calls[0]?.[1]).toBe("warning");
	});
});
