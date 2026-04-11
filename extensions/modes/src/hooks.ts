import { randomUUID } from "crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import {
	createRequestEnvelope,
	HANDOFF_EXECUTION_KICKOFF_EVENT,
	HANDOFF_GET_CHANNEL,
	HANDOFF_MARK_CONSUMED_CHANNEL,
	HANDOFF_PING_CHANNEL,
	HANDOFF_READY_EVENT,
	HOUTU_EXECUTION_HANDOFF_SENTINEL_PREFIX,
} from "../../handoff/src/protocol.js";
import type {
	HandoffAuthorityRecord,
	HandoffExecutionKickoffEvent,
	HandoffGetData,
	HandoffMarkConsumedData,
	HandoffPingData,
	HandoffReadiness,
	HandoffRpcReply,
} from "../../handoff/src/types.js";
import { MODES, MODE_ALIASES } from "./constants.js";
import type { ModeStateManager } from "./mode-state.js";
import { derivePlanTitleFromMarkdown, hydratePlanState } from "./plan-storage.js";
import { promptPostPlanAction, recoverPlanReview } from "./plannotator.js";
import type { Mode, ModeState } from "./types.js";
import { isDelegationAllowed, isSafeCommand } from "./utils.js";
import { getLocalPlanPath, LOCAL_PLAN_URI, readLocalPlanFile } from "./plan-local.js";

const HANDOFF_RPC_TIMEOUT_MS = 1_500;
const HANDOFF_REPLAY_RECOVERY_NOTE = "Switched back to Fu Xi. Rerun Execute from the latest saved plan.";

type AssistantMessageLike = { role?: string; stopReason?: string };
type PendingExecutionHandoffResult =
	| {
		ok: true;
		authority: HandoffAuthorityRecord;
		briefing: string;
		readiness: HandoffReadiness;
	  }
	| {
		ok: false;
		reason: string;
		readiness?: HandoffReadiness;
	  };

function isPlanWriteTarget(input: unknown, planPath: string): boolean {
	const path = (input as { path?: unknown })?.path;
	return typeof path === "string" && (path === LOCAL_PLAN_URI || path === planPath);
}

function getString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isSuccessfulPlanMutationResult(event: {
	toolName: string;
	input?: unknown;
	details?: unknown;
	isError?: boolean;
}, planPath: string): boolean {
	if (event.isError || (event.toolName !== "write" && event.toolName !== "edit")) {
		return false;
	}

	const details = event.details && typeof event.details === "object" ? (event.details as Record<string, unknown>) : undefined;
	const localPath = getString(details?.localPath);
	if (localPath) {
		return localPath === LOCAL_PLAN_URI;
	}

	const backingPath = getString(details?.backingPath) ?? getString(details?.resolvedPath);
	if (backingPath) {
		return backingPath === planPath;
	}

	const inputPath = getString((event.input as { path?: unknown } | undefined)?.path);
	return inputPath === planPath;
}

async function refreshPlanStateFromLocalPlan(ctx: Parameters<typeof readLocalPlanFile>[0], state: ModeStateManager): Promise<void> {
	const content = await readLocalPlanFile(ctx);
	const title = derivePlanTitleFromMarkdown(content);
	state.planContent = content;
	state.planTitle = title;
	state.planTitleSource = title ? "content-h1" : undefined;
}

function getLastAssistantStopReason(messages: AssistantMessageLike[] | undefined): string | undefined {
	if (!Array.isArray(messages)) {
		return undefined;
	}

	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "assistant") {
			return message.stopReason;
		}
	}

	return undefined;
}

function isStartupReadiness(readiness: HandoffReadiness | undefined): boolean {
	return readiness?.startupStatus === "bootstrapping" || readiness?.startupStatus === "awaiting-handlers";
}

function getReplyReadiness<T>(reply: HandoffRpcReply<T> | undefined): HandoffReadiness | undefined {
	if (!reply) {
		return undefined;
	}

	if (reply.success === true) {
		const data = reply.data as { readiness?: HandoffReadiness } | undefined;
		return data?.readiness;
	}

	return reply.readiness;
}

async function requestHandoffRpc<T>(
	pi: ExtensionAPI,
	channel: string,
	payload: Record<string, unknown>,
	timeoutMs = HANDOFF_RPC_TIMEOUT_MS,
): Promise<HandoffRpcReply<T> | undefined> {
	const requestId = `modes-handoff-${randomUUID()}`;
	const replyChannel = `${channel}:reply:${requestId}`;

	return await new Promise<HandoffRpcReply<T> | undefined>((resolve) => {
		let settled = false;
		let unsubscribe = () => {};
		const finish = (reply: HandoffRpcReply<T> | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			unsubscribe();
			resolve(reply);
		};
		const timeoutId = setTimeout(() => finish(undefined), timeoutMs);

		unsubscribe = pi.events.on(replyChannel, (raw: unknown) => {
			finish(raw as HandoffRpcReply<T>);
		});

		try {
			pi.events.emit(channel, createRequestEnvelope(requestId, payload, "modes-houtu-kickoff"));
		} catch {
			finish(undefined);
		}
	});
}

async function waitForHandoffReadyEvent(pi: ExtensionAPI, timeoutMs = HANDOFF_RPC_TIMEOUT_MS): Promise<HandoffReadiness | undefined> {
	return await new Promise<HandoffReadiness | undefined>((resolve) => {
		let settled = false;
		let unsubscribe = () => {};
		const finish = (readiness: HandoffReadiness | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			unsubscribe();
			resolve(readiness);
		};
		const timeoutId = setTimeout(() => finish(undefined), timeoutMs);

		unsubscribe = pi.events.on(HANDOFF_READY_EVENT, (raw: unknown) => {
			const readiness = (raw as { readiness?: HandoffReadiness } | null)?.readiness;
			finish(readiness);
		});
	});
}

async function waitForSettledHandoffReadiness(pi: ExtensionAPI): Promise<HandoffReadiness | undefined> {
	const initialReply = await requestHandoffRpc<HandoffPingData>(pi, HANDOFF_PING_CHANNEL, {});
	const initialReadiness = getReplyReadiness(initialReply);
	if (!isStartupReadiness(initialReadiness)) {
		return initialReadiness;
	}

	const retryReply = await requestHandoffRpc<HandoffPingData>(pi, HANDOFF_PING_CHANNEL, {});
	const retryReadiness = getReplyReadiness(retryReply) ?? initialReadiness;
	if (!isStartupReadiness(retryReadiness)) {
		return retryReadiness;
	}

	await waitForHandoffReadyEvent(pi);
	const settledReply = await requestHandoffRpc<HandoffPingData>(pi, HANDOFF_PING_CHANNEL, {});
	return getReplyReadiness(settledReply) ?? retryReadiness;
}

async function loadPendingExecutionHandoff(
	pi: ExtensionAPI,
	expectedHandoffId: string,
): Promise<PendingExecutionHandoffResult> {
	const reply = await requestHandoffRpc<HandoffGetData>(pi, HANDOFF_GET_CHANNEL, {});
	const readiness = getReplyReadiness(reply);
	if (!reply) {
		return {
			ok: false,
			reason: `Execution handoff ${expectedHandoffId} could not be loaded because the handoff service did not respond.`,
		};
	}

	if (reply.success !== true) {
		return {
			ok: false,
			reason: reply.error?.trim() || `Execution handoff ${expectedHandoffId} could not be loaded.`,
			readiness,
		};
	}

	const authority = reply.data?.authority;
	if (!authority) {
		return {
			ok: false,
			reason: readiness?.reason ?? `Execution handoff ${expectedHandoffId} no longer has persisted authority.`,
			readiness,
		};
	}

	if (authority.handoffId !== expectedHandoffId) {
		return {
			ok: false,
			reason: `Execution handoff ${expectedHandoffId} no longer matches the current pending handoff.`,
			readiness,
		};
	}

	if (authority.status !== "pending") {
		return {
			ok: false,
			reason: readiness?.reason ?? `Execution handoff ${expectedHandoffId} is ${authority.status}.`,
			readiness,
		};
	}

	if (!readiness?.ready) {
		return {
			ok: false,
			reason: readiness?.reason ?? `Execution handoff ${expectedHandoffId} is not ready.`,
			readiness,
		};
	}

	const briefing = reply.data?.briefing?.trim();
	if (!briefing) {
		return {
			ok: false,
			reason: readiness.reason ?? `Execution handoff ${expectedHandoffId} briefing is missing.`,
			readiness,
		};
	}

	return {
		ok: true,
		authority,
		briefing,
		readiness,
	};
}

function buildExecutionRecoveryMessage(reason: string): string {
	return `${reason} ${HANDOFF_REPLAY_RECOVERY_NOTE}`;
}

function restoreFuXiAfterInvalidKickoff(state: ModeStateManager, ctx: Parameters<ModeStateManager["switchMode"]>[1]): void {
	state.justSwitchedToHoutu = false;
	state.resetExecutionHandoffState();
	state.planActionPending = true;
	state.switchMode("fuxi", ctx);
}

function applyExecutionKickoffSync(state: ModeStateManager, event: HandoffExecutionKickoffEvent): void {
	if (event.status === "accepted") {
		if (state.pendingExecutionHandoffId !== event.handoffId || !state.executionKickoffQueued) return;
		state.activeKickoffHandoffId = event.handoffId;
		state.activeInjectedHandoffId = undefined;
		state.executionKickoffQueued = false;
		state.persistState();
		return;
	}

	if (state.currentMode !== "houtu") return;
	if (state.pendingExecutionHandoffId !== event.handoffId && !state.executionKickoffQueued) return;

	const ctx = state.activeCtx;
	if (!ctx) return;

	restoreFuXiAfterInvalidKickoff(state, ctx);
}

function filterHoutuContextMessages(messages: unknown[]): unknown[] {
	const handoffIndex = messages.findIndex((message) => (message as { customType?: unknown } | null)?.customType === "handoff-context");
	return messages.filter((message, index) => {
		const customType = (message as { customType?: unknown } | null)?.customType;
		if (customType === "plan-mode-context") return false;
		if (handoffIndex < 0) return true;
		return index >= handoffIndex;
	});
}

async function maybeReplayQueuedExecutionKickoff(
	pi: ExtensionAPI,
	state: ModeStateManager,
	ctx: Parameters<ModeStateManager["switchMode"]>[1],
): Promise<boolean> {
	const pendingHandoffId = state.pendingExecutionHandoffId;
	if (state.currentMode !== "houtu" || !pendingHandoffId || !state.executionKickoffQueued) {
		return false;
	}

	const readiness = await waitForSettledHandoffReadiness(pi);
	if (readiness?.ready && readiness.handoffId === pendingHandoffId) {
		setTimeout(() => pi.sendUserMessage(`${HOUTU_EXECUTION_HANDOFF_SENTINEL_PREFIX}${pendingHandoffId}`, { deliverAs: "followUp" }), 0);
		return true;
	}

	restoreFuXiAfterInvalidKickoff(state, ctx);
	if (ctx.hasUI) {
		ctx.ui.notify(buildExecutionRecoveryMessage(readiness?.reason ?? `Execution handoff ${pendingHandoffId} could not be recovered.`), "warning");
	}
	await promptPostPlanAction(pi, state, ctx);
	return true;
}

async function maybeFinalizeInjectedHandoff(
	pi: ExtensionAPI,
	state: ModeStateManager,
	event: { messages?: AssistantMessageLike[] },
): Promise<void> {
	const handoffId = state.activeInjectedHandoffId;
	if (!handoffId) {
		return;
	}

	const stopReason = getLastAssistantStopReason(event.messages);
	state.clearRuntimeExecutionHandoffState();

	// agent_end currently exposes the last assistant stopReason but not richer terminal
	// status metadata here. To avoid consuming a handoff on ambiguous outcomes, only mark
	// it consumed when an assistant message exists and the turn did not end with abort/error.
	if (!stopReason || stopReason === "aborted" || stopReason === "error") {
		return;
	}

	const reply = await requestHandoffRpc<HandoffMarkConsumedData>(pi, HANDOFF_MARK_CONSUMED_CHANNEL, {
		consumedAt: new Date().toISOString(),
	});
	if (reply?.success === true && reply.data?.authority?.handoffId === handoffId && state.pendingExecutionHandoffId === handoffId) {
		state.pendingExecutionHandoffId = undefined;
		state.persistState();
	}
}

export function registerModeHooks(pi: ExtensionAPI, state: ModeStateManager): void {
	pi.events.on(HANDOFF_EXECUTION_KICKOFF_EVENT, (raw) => {
		const event = raw as Partial<HandoffExecutionKickoffEvent> | null;
		if (!event || typeof event.handoffId !== "string") return;
		if (event.status !== "accepted" && event.status !== "invalid") return;
		applyExecutionKickoffSync(state, {
			handoffId: event.handoffId,
			status: event.status,
			reason: typeof event.reason === "string" ? event.reason : undefined,
		});
	});

	// Block invalid delegations and destructive bash in mode-specific contexts
	pi.on("tool_call", async (event, ctx) => {
		const config = state.loadConfig(state.currentMode);

		if (event.toolName === "Agent") {
			const requestedType = (event.input as { subagent_type?: string }).subagent_type ?? "";
			const delegation = isDelegationAllowed(config, requestedType);
			if (!delegation.allowed) {
				const allowedText = delegation.permittedTargets?.length
					? delegation.permittedTargets.join(", ")
					: "all except targets blocked by disallow_delegation_to";
				return {
					block: true,
					reason: `Mode ${state.currentMode}: delegation to "${requestedType}" is blocked by frontmatter policy. Allowed targets: ${allowedText}`,
				};
			}
		}

		if (state.currentMode !== "fuxi") return;

		if (event.toolName === "write" || event.toolName === "edit") {
			const planPath = getLocalPlanPath(ctx);
			if (!isPlanWriteTarget(event.input, planPath)) {
				const path = (event.input as { path?: unknown })?.path;
				const target = typeof path === "string" && path ? path : "<missing path>";
				return {
					block: true,
					reason: `Plan mode: ${event.toolName} is restricted to ${LOCAL_PLAN_URI}. Target: ${target}`,
				};
			}
			return;
		}

		if (event.toolName !== "bash") return;
		const command = (event.input as { command?: string }).command ?? "";
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not read-only). Use /mode kuafu to switch to build mode first.\nCommand: ${command}`,
			};
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (state.currentMode !== "fuxi") return;

		const planPath = getLocalPlanPath(ctx);
		if (!isSuccessfulPlanMutationResult(event, planPath)) return;

		await refreshPlanStateFromLocalPlan(ctx, state);
		state.resetPlanReviewState();
		state.persistState();
	});

	// Prompt injection via before_agent_start
	pi.on("before_agent_start", async (event, ctx) => {
		state.activeCtx = ctx;
		const config = state.loadConfig(state.currentMode);
		const systemPrompt = config.body ? `${event.systemPrompt}\n\n${config.body}` : event.systemPrompt;

		const activeKickoffHandoffId = state.activeKickoffHandoffId;
		if (
			state.currentMode === "houtu" &&
			activeKickoffHandoffId &&
			state.pendingExecutionHandoffId === activeKickoffHandoffId &&
			state.activeInjectedHandoffId !== activeKickoffHandoffId
		) {
			const pendingHandoff = await loadPendingExecutionHandoff(pi, activeKickoffHandoffId);
			if (pendingHandoff.ok) {
				state.activeInjectedHandoffId = activeKickoffHandoffId;
				return {
					message: {
						customType: "handoff-context",
						content: pendingHandoff.briefing,
						display: true,
					},
					systemPrompt,
				};
			}
			state.clearRuntimeExecutionHandoffState();
		}

		if (!config.body) return;
		return { systemPrompt };
	});

	// Context: keep the execution handoff and messages that follow it
	pi.on("context", async (event) => {
		if (state.currentMode !== "houtu") return;

		return {
			messages: filterHoutuContextMessages(event.messages),
		};
	});

	// Post-plan prompt: after Fu Xi finishes, ask what's next. Also consume kickoff handoffs only after a successful terminal turn.
	pi.on("agent_end", async (event, ctx) => {
		state.activeCtx = ctx;
		await maybeFinalizeInjectedHandoff(pi, state, event as { messages?: AssistantMessageLike[] });
		if (state.currentMode !== "fuxi" || !ctx.hasUI) return;
		if (state.hasPendingReview()) return;
		await promptPostPlanAction(pi, state, ctx);
	});

	// Session start: restore state
	pi.on("session_start", async (_event, ctx) => {
		state.activeCtx = ctx;
		state.plannotatorAvailable = undefined;
		state.plannotatorUnavailableReason = undefined;
		state.clearRuntimeExecutionHandoffState();

		// Tab on empty editor → cycle mode; otherwise pass through to autocomplete
		if (ctx.hasUI) {
			ctx.ui.setEditorComponent((tui, theme, keybindings) => {
				const BaseEditor = CustomEditor as unknown as new (...args: unknown[]) => {
					handleInput(data: string): void;
					getText(): string;
				};
				class ModeEditor extends BaseEditor {
					handleInput(data: string): void {
						if (matchesKey(data, Key.tab) && !this.getText().trim()) {
							if (state.activeCtx) state.cycleMode(state.activeCtx);
							return;
						}
						super.handleInput(data);
					}
				}
				return new ModeEditor(tui, theme, keybindings);
			});
		}

		// Check --mode flag
		const flagValue = pi.getFlag("mode");
		if (typeof flagValue === "string" && flagValue && flagValue !== "kuafu") {
			const resolved = MODE_ALIASES[flagValue] ?? (MODES.includes(flagValue as Mode) ? (flagValue as Mode) : null);
			if (resolved) {
				state.currentMode = resolved;
			}
		}

		// Restore persisted state (unless flag overrode)
		if (!flagValue || flagValue === "kuafu") {
			const entries = ctx.sessionManager.getEntries();
			const modeEntry = entries
				.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "agent-mode")
				.pop() as { data?: ModeState } | undefined;

			if (modeEntry?.data) {
				state.currentMode = modeEntry.data.mode ?? state.currentMode;
				state.planTitle = modeEntry.data.planTitle;
				state.planTitleSource = modeEntry.data.planTitleSource;
				state.planContent = modeEntry.data.planContent;
				state.gapReviewApproved = modeEntry.data.gapReviewApproved ?? false;
				state.gapReviewFeedback = modeEntry.data.gapReviewFeedback;
				state.pendingPlanReviewId = modeEntry.data.planReviewId;
				state.planReviewPending = modeEntry.data.planReviewPending ?? false;
				state.planReviewApproved = modeEntry.data.planReviewApproved ?? false;
				state.planReviewFeedback = modeEntry.data.planReviewFeedback;
				state.highAccuracyReviewPending = modeEntry.data.highAccuracyReviewPending ?? false;
				state.highAccuracyReviewApproved = modeEntry.data.highAccuracyReviewApproved ?? false;
				state.highAccuracyReviewFeedback = modeEntry.data.highAccuracyReviewFeedback;
				state.planActionPending = modeEntry.data.planActionPending ?? false;
				state.pendingExecutionHandoffId = modeEntry.data.pendingExecutionHandoffId;
				state.executionKickoffQueued = modeEntry.data.executionKickoffQueued ?? false;
			}
		}
		if (!state.pendingPlanReviewId) {
			state.planReviewPending = false;
		}

		if (state.highAccuracyReviewPending) {
			state.highAccuracyReviewPending = false;
			state.planActionPending = true;
			if (ctx.hasUI) {
				ctx.ui.notify("Pending high accuracy review could not be recovered. Returning to the post-plan menu.", "warning");
			}
		}

		await hydratePlanState(ctx, state);

		state.applyMode(ctx);
		await recoverPlanReview(pi, state, ctx);
		state.persistState();
		if (await maybeReplayQueuedExecutionKickoff(pi, state, ctx)) {
			return;
		}
		await promptPostPlanAction(pi, state, ctx);
	});

	// Session shutdown: clear context
	pi.on("session_shutdown", async () => {
		state.activeCtx = undefined;
		state.plannotatorAvailable = undefined;
		state.plannotatorUnavailableReason = undefined;
		state.clearRuntimeExecutionHandoffState();
	});
}
