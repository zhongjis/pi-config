import { randomUUID } from "crypto";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	createRequestEnvelope,
	HANDOFF_PREPARE_CHANNEL,
	HOUTU_EXECUTION_HANDOFF_SENTINEL_PREFIX,
} from "../../handoff/src/protocol.js";
import type { HandoffPrepareData, HandoffPreparePayload, HandoffRpcReply } from "../../handoff/src/types.js";
import { PLANNOTATOR_REQUEST_CHANNEL, PLANNOTATOR_TIMEOUT_MS } from "./constants.js";
import { buildHighAccuracyReviewMessage, buildRefinementMessage } from "./plan-context.js";
import type { ModeStateManager } from "./mode-state.js";
import { LOCAL_PLAN_URI } from "./plan-local.js";
import { hydratePlanState } from "./plan-storage.js";
import type {
	PlannotatorPlanReviewPayload,
	PlannotatorPlanReviewStartResult,
	PlannotatorResponse,
	PlannotatorReviewResultEvent,
	PlannotatorReviewStatusResult,
} from "./types.js";

const PLANNOTATOR_AVAILABLE_LABEL = "Refine in Plannotator";
const PLANNOTATOR_UNAVAILABLE_LABEL = "Refine in Plannotator (Unavailable)";
const VIEW_FULL_PLAN_LABEL = "View full plan here";
const HOUTU_AUTO_START_MESSAGE = `Start executing approved plan now. Use injected handoff context from ${LOCAL_PLAN_URI}. Do not restate the full plan in chat.`;

function getPlannotatorUnavailableReason(reason?: string): string {
	const trimmed = reason?.trim();
	return trimmed || "Plannotator is unavailable.";
}

function logPlannotatorUnavailable(scope: string, reason?: string): void {
	console.error(`[modes/plannotator] ${scope}: ${getPlannotatorUnavailableReason(reason)}`);
}

function ensureSentence(value: string): string {
	return /[.!?]$/u.test(value) ? value : `${value}.`;
}

function buildExecutionHandoffBriefing(state: ModeStateManager, cleanup: HandoffCleanupResult): string {
	const planTitle = state.planTitle ?? "untitled";
	const sections = [
		`Execute the approved plan "${planTitle}" in Hou Tu.`,
		"",
		"## Plan",
		`- Title: ${planTitle}`,
		`- Reference: ${LOCAL_PLAN_URI}`,
		"",
		"## Review context",
		`- Gap review: ${state.gapReviewApproved ? "approved" : "not recorded"}`,
		`- Plannotator review: ${state.planReviewApproved ? "approved" : "not requested"}`,
		`- High accuracy review: ${state.highAccuracyReviewApproved ? "approved" : "not requested"}`,
	];

	const gapFeedback = state.gapReviewFeedback?.trim();
	if (gapFeedback) {
		sections.push("", "### Gap review feedback", gapFeedback);
	}

	const plannotatorFeedback = state.planReviewApproved ? state.planReviewFeedback?.trim() : undefined;
	if (plannotatorFeedback) {
		sections.push("", "### Plannotator notes", plannotatorFeedback);
	}

	const highAccuracyFeedback = state.highAccuracyReviewApproved ? state.highAccuracyReviewFeedback?.trim() : undefined;
	if (highAccuracyFeedback) {
		sections.push("", "### High accuracy review notes", highAccuracyFeedback);
	}

	sections.push("", "## Cleanup context", `- Planning-task cleanup: ${ensureSentence(cleanup.summary)}`);
	return sections.join("\n");
}

function buildExecutionHandoffNotification(
	cleanup: HandoffCleanupResult,
	handoff: HandoffPreparationResult,
): { message: string; level: "info" | "warning" } {
	const parts = [`Planning-task cleanup: ${ensureSentence(cleanup.summary)}`];
	if (handoff.success) {
		parts.push(ensureSentence(handoff.summary));
		parts.push("Plan mode complete. Hou Tu handoff is ready. Hou Tu starting now.");
		return {
			message: parts.join(" "),
			level: cleanup.level === "info" ? "info" : "warning",
		};
	}

	parts.push(ensureSentence(handoff.summary));
	parts.push("Stayed in Fu Xi so you can retry handoff preparation.");
	return {
		message: parts.join(" "),
		level: "warning",
	};
}

const HANDOFF_TASK_CLEANUP_CHANNEL = "tasks:rpc:clear-planning-tasks";
const HANDOFF_TASK_CLEANUP_TIMEOUT_MS = 1_500;
const HANDOFF_PREPARE_TIMEOUT_MS = 1_500;
const PLANNOTATOR_HEALTH_SENTINEL_REVIEW_ID = "__plannotator_health_check__";

type ClearPlanningTasksReply = {
	success?: boolean;
	data?: {
		status?: "cleared" | "already_clean";
		removed?: number;
		removedIncomplete?: number;
	};
	error?: string;
};

type HandoffCleanupResult = {
	status: "cleared" | "already_clean" | "unavailable";
	summary: string;
	level: "info" | "warning";
};

type HandoffPreparationResult =
	| {
		success: true;
		handoffId: string;
		kickoffPrompt: string;
		summary: string;
		level: "info";
	  }
	| {
		success: false;
		summary: string;
		level: "warning";
	  };

export async function requestPlannotator<T>(
	pi: ExtensionAPI,
	action: "plan-review" | "review-status",
	payload: Record<string, unknown>,
): Promise<PlannotatorResponse<T>> {
	const requestId = `${action}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	return await new Promise<PlannotatorResponse<T>>((resolve) => {
		let settled = false;
		const timeoutId = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve({ status: "unavailable", error: "Plannotator request timed out." });
		}, PLANNOTATOR_TIMEOUT_MS);

		pi.events.emit(PLANNOTATOR_REQUEST_CHANNEL, {
			requestId,
			action,
			payload,
			respond: (response: PlannotatorResponse<T>) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				resolve(response);
			},
		});
	});
}

async function checkPlannotatorAvailability(
	pi: ExtensionAPI,
	state: ModeStateManager,
): Promise<{ available: boolean; reason?: string }> {
	if (typeof state.plannotatorAvailable === "boolean") {
		return {
			available: state.plannotatorAvailable,
			reason: state.plannotatorUnavailableReason,
		};
	}

	const response = await requestPlannotator<PlannotatorReviewStatusResult>(pi, "review-status", {
		reviewId: PLANNOTATOR_HEALTH_SENTINEL_REVIEW_ID,
	});

	if (response.status === "handled") {
		state.plannotatorAvailable = true;
		state.plannotatorUnavailableReason = undefined;
		return { available: true };
	}

	const reason = response.status === "unavailable" ? response.error : response.error;
	state.plannotatorAvailable = false;
	state.plannotatorUnavailableReason = getPlannotatorUnavailableReason(reason);
	logPlannotatorUnavailable("availability check failed", state.plannotatorUnavailableReason);
	return { available: false, reason: state.plannotatorUnavailableReason };
}

async function clearPlanningTasksForHandoff(pi: ExtensionAPI, sessionId: string): Promise<HandoffCleanupResult> {
	const requestId = `clear-planning-tasks-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const replyChannel = `${HANDOFF_TASK_CLEANUP_CHANNEL}:reply:${requestId}`;
	const fallback: HandoffCleanupResult = {
		status: "unavailable",
		summary: "planning-task cleanup unavailable",
		level: "warning",
	};

	return await new Promise<HandoffCleanupResult>((resolve) => {
		let settled = false;
		let unsubscribe = () => {};
		const finish = (result: HandoffCleanupResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			unsubscribe();
			resolve(result);
		};
		const timeoutId = setTimeout(() => finish(fallback), HANDOFF_TASK_CLEANUP_TIMEOUT_MS);

		unsubscribe = pi.events.on(replyChannel, (raw: unknown) => {
			const reply = raw as ClearPlanningTasksReply | null;
			if (!reply || reply.success !== true || !reply.data) {
				finish(fallback);
				return;
			}

			if (
				reply.data.status === "cleared" &&
				typeof reply.data.removed === "number" &&
				typeof reply.data.removedIncomplete === "number"
			) {
				finish({
					status: "cleared",
					summary:
						reply.data.removedIncomplete > 0
							? `cleared ${reply.data.removed} planning tasks (${reply.data.removedIncomplete} incomplete)`
							: `cleared ${reply.data.removed} planning tasks`,
					level: "info",
				});
				return;
			}

			if (reply.data.status === "already_clean") {
				finish({
					status: "already_clean",
					summary: "no planning tasks needed cleanup",
					level: "info",
				});
				return;
			}

			finish(fallback);
		});

		try {
			pi.events.emit(HANDOFF_TASK_CLEANUP_CHANNEL, {
				requestId,
				source: "plan-execute-handoff",
				sessionId,
			});
		} catch {
			finish(fallback);
		}
	});
}

async function prepareExecutionHandoff(
	pi: ExtensionAPI,
	state: ModeStateManager,
	cleanup: HandoffCleanupResult,
): Promise<HandoffPreparationResult> {
	const handoffId = randomUUID();
	const kickoffPrompt = `${HOUTU_EXECUTION_HANDOFF_SENTINEL_PREFIX}${handoffId}`;
	const requestId = `handoff-prepare-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const replyChannel = `${HANDOFF_PREPARE_CHANNEL}:reply:${requestId}`;
	const payload: HandoffPreparePayload = {
		handoffId,
		briefing: buildExecutionHandoffBriefing(state, cleanup),
		producerMode: "fuxi",
		targetMode: "houtu",
		kickoffPrompt,
		createdAt: new Date().toISOString(),
	};
	const fallback: HandoffPreparationResult = {
		success: false,
		summary: "Execution handoff could not be prepared because the handoff service did not respond",
		level: "warning",
	};

	return await new Promise<HandoffPreparationResult>((resolve) => {
		let settled = false;
		let unsubscribe = () => {};
		const finish = (result: HandoffPreparationResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			unsubscribe();
			resolve(result);
		};
		const timeoutId = setTimeout(() => finish(fallback), HANDOFF_PREPARE_TIMEOUT_MS);

		unsubscribe = pi.events.on(replyChannel, (raw: unknown) => {
			const reply = raw as HandoffRpcReply<HandoffPrepareData> | null;
			if (!reply) {
				finish(fallback);
				return;
			}

			if (reply.success !== true || !reply.data?.authority?.handoffId || !reply.data.authority.kickoffPrompt) {
				const reason = reply.success === false ? reply.error?.trim() : undefined;
				finish({
					success: false,
					summary: reason ? `Execution handoff could not be prepared: ${reason}` : "Execution handoff could not be prepared",
					level: "warning",
				});
				return;
			}

			finish({
				success: true,
				handoffId: reply.data.authority.handoffId,
				kickoffPrompt: reply.data.authority.kickoffPrompt,
				summary: `Execution handoff prepared for Hou Tu (handoff ${reply.data.authority.handoffId})`,
				level: "info",
			});
		});

		try {
			pi.events.emit(HANDOFF_PREPARE_CHANNEL, createRequestEnvelope(requestId, payload, "plan-execute-handoff"));
		} catch (error) {
			const message = error instanceof Error ? error.message.trim() : String(error);
			finish({
				success: false,
				summary: message ? `Execution handoff could not be prepared: ${message}` : "Execution handoff could not be prepared",
				level: "warning",
			});
		}
	});
}

export async function prepareApprovedPlanHandoff(
	pi: ExtensionAPI,
	state: ModeStateManager,
	ctx: ExtensionContext,
	options: { reopenApprovalMenuOnFailure?: boolean } = {},
): Promise<{ success: boolean; message: string; level: "info" | "warning"; details?: Record<string, unknown> }> {
	state.planActionPending = false;
	state.resetExecutionHandoffState();
	state.persistState();

	const cleanupResult = await clearPlanningTasksForHandoff(pi, ctx.sessionManager.getSessionId());
	const handoffResult = await prepareExecutionHandoff(pi, state, cleanupResult);
	const notification = buildExecutionHandoffNotification(cleanupResult, handoffResult);

	if (!handoffResult.success) {
		state.planActionPending = true;
		state.persistState();
		if (ctx.hasUI) {
			ctx.ui.notify(notification.message, notification.level);
		}
		if (options.reopenApprovalMenuOnFailure !== false) {
			await promptPostPlanAction(pi, state, ctx);
		}
		return { success: false, message: notification.message, level: notification.level };
	}

	state.pendingExecutionHandoffId = handoffResult.handoffId;
	state.clearRuntimeExecutionHandoffState();
	state.persistState();
	state.switchMode("houtu", ctx);
	if (ctx.hasUI) {
		ctx.ui.notify(notification.message, notification.level);
	}
	setTimeout(() => {
		pi.sendUserMessage(HOUTU_AUTO_START_MESSAGE, { deliverAs: "followUp" });
		ctx.abort?.();
	}, 0);

	return {
		success: true,
		message: notification.message,
		level: notification.level,
		details: { handoffId: handoffResult.handoffId, planTitle: state.planTitle, autoStartQueued: true },
	};
}

export async function promptPostPlanAction(pi: ExtensionAPI, state: ModeStateManager, ctx: ExtensionContext): Promise<void> {
	if (state.currentMode !== "fuxi" || !ctx.hasUI) return;
	const snapshot = await hydratePlanState(ctx, state);
	if (!snapshot || !state.planTitle || !state.planActionPending || state.hasPendingReview()) return;

	const approvalLabel = state.planApproved || state.planReviewApproved || state.highAccuracyReviewApproved
		? "Hand off to Hou Tu"
		: "Approve and hand off to Hou Tu";
	const choices: string[] = [approvalLabel, VIEW_FULL_PLAN_LABEL];
	if (!state.planReviewApproved) {
		const plannotator = await checkPlannotatorAvailability(pi, state);
		choices.push(plannotator.available ? PLANNOTATOR_AVAILABLE_LABEL : PLANNOTATOR_UNAVAILABLE_LABEL);
	}
	if (!state.highAccuracyReviewApproved) {
		choices.push("High accuracy review");
	}

	const choice = await ctx.ui.select(`Plan "${state.planTitle}" finalized. Choose approval path.`, choices);
	if (!choice) return;

	if (choice === approvalLabel) {
		if (!state.planReviewApproved && !state.highAccuracyReviewApproved) {
			state.planApproved = true;
			state.planApprovalSource = "user";
		}
		state.persistState();
		await prepareApprovedPlanHandoff(pi, state, ctx);
		return;
	}

	if (choice === VIEW_FULL_PLAN_LABEL) {
		await ctx.ui.editor(`View full plan here — ${state.planTitle}`, snapshot.content);
		await promptPostPlanAction(pi, state, ctx);
		return;
	}

	if (choice === PLANNOTATOR_AVAILABLE_LABEL) {
		state.planApproved = false;
		state.planApprovalSource = undefined;
		state.planActionPending = false;
		state.persistState();
		const reviewMessage = await startPlanReview(pi, state, ctx);
		if (ctx.hasUI) {
			ctx.ui.notify(reviewMessage, state.planReviewPending ? "info" : "warning");
		}
		if (!state.planReviewPending) {
			await promptPostPlanAction(pi, state, ctx);
		}
		return;
	}

	if (choice === PLANNOTATOR_UNAVAILABLE_LABEL) {
		const reason = getPlannotatorUnavailableReason(state.plannotatorUnavailableReason);
		ctx.ui.notify(`Plannotator unavailable: ${reason}`, "warning");
		await promptPostPlanAction(pi, state, ctx);
		return;
	}

	if (choice === "High accuracy review") {
		state.planApproved = false;
		state.planApprovalSource = undefined;
		state.highAccuracyReviewPending = true;
		state.highAccuracyReviewApproved = false;
		state.highAccuracyReviewFeedback = undefined;
		state.planActionPending = false;
		state.persistState();
		setTimeout(() => pi.sendUserMessage(buildHighAccuracyReviewMessage(state), { deliverAs: "followUp" }), 0);
		return;
	}
}

export async function handlePlanReviewResult(
	pi: ExtensionAPI,
	state: ModeStateManager,
	result: PlannotatorReviewResultEvent,
	ctx?: ExtensionContext,
): Promise<void> {
	if (!state.pendingPlanReviewId || result.reviewId !== state.pendingPlanReviewId) return;

	if (ctx) {
		await hydratePlanState(ctx, state);
	}

	state.pendingPlanReviewId = undefined;
	state.planReviewPending = false;
	state.planReviewFeedback = result.feedback?.trim() || undefined;

	if (result.approved) {
		state.planReviewApproved = true;
		state.planApproved = true;
		state.planApprovalSource = "plannotator";
		state.planActionPending = true;
		state.persistState();
		if (ctx?.hasUI) {
			ctx.ui.notify(`Plan "${state.planTitle ?? "untitled"}" approved in Plannotator.`, "info");
		}
		if (ctx) {
			await prepareApprovedPlanHandoff(pi, state, ctx);
		}
		return;
	}

	state.planReviewApproved = false;
	state.planApproved = false;
	state.planApprovalSource = undefined;
	state.planActionPending = false;
	state.persistState();
	if (ctx?.hasUI) {
		ctx.ui.notify(`Plan "${state.planTitle ?? "untitled"}" needs refinement in Plannotator.`, "warning");
	}
	if (state.currentMode === "fuxi") {
		pi.sendUserMessage(buildRefinementMessage(state), { deliverAs: "followUp" });
	}
}

export async function startPlanReview(pi: ExtensionAPI, state: ModeStateManager, ctx: ExtensionContext): Promise<string> {
	const snapshot = await hydratePlanState(ctx, state);
	if (!snapshot || !state.planTitle) {
		return `Error: No plan found in ${LOCAL_PLAN_URI}. Write or save the plan to ${LOCAL_PLAN_URI} first.`;
	}

	const response = await requestPlannotator<PlannotatorPlanReviewStartResult>(pi, "plan-review", {
		planContent: snapshot.content,
		origin: "fuxi-explicit-refine",
	} satisfies PlannotatorPlanReviewPayload);

	if (response.status === "handled" && response.result.status === "pending") {
		state.pendingPlanReviewId = response.result.reviewId;
		state.planReviewPending = true;
		state.planReviewApproved = false;
		state.planReviewFeedback = undefined;
		state.planApproved = false;
		state.planApprovalSource = undefined;
		state.planActionPending = false;
		state.plannotatorAvailable = true;
		state.plannotatorUnavailableReason = undefined;
		state.persistState();
		return `Plan "${state.planTitle}" sent to Plannotator for refinement review.`;
	}

	state.pendingPlanReviewId = undefined;
	state.planReviewPending = false;
	state.planReviewApproved = false;
	state.planReviewFeedback = undefined;
	state.planApproved = false;
	state.planApprovalSource = undefined;
	state.planActionPending = true;
	state.persistState();
	state.plannotatorAvailable = false;
	state.plannotatorUnavailableReason = getPlannotatorUnavailableReason(
		response.status === "handled" ? "Plannotator review could not be started." : response.error,
	);

	logPlannotatorUnavailable(`review start failed for plan \"${state.planTitle}\"`, state.plannotatorUnavailableReason);

	if (ctx.hasUI) {
		ctx.ui.notify(`${state.plannotatorUnavailableReason} Returning to the approval menu.`, "warning");
	}
	return `Plannotator review could not be started for plan "${state.planTitle}". Returning to the approval menu.`;
}

export async function recoverPlanReview(pi: ExtensionAPI, state: ModeStateManager, ctx: ExtensionContext): Promise<void> {
	if (!state.pendingPlanReviewId) return;

	await hydratePlanState(ctx, state);

	const reviewId = state.pendingPlanReviewId;
	const response = await requestPlannotator<PlannotatorReviewStatusResult>(pi, "review-status", {
		reviewId,
	});

	if (response.status === "handled") {
		if (response.result.status === "completed") {
			await handlePlanReviewResult(pi, state, response.result, ctx);
			return;
		}
		if (response.result.status === "pending") {
			return;
		}
	}

	state.pendingPlanReviewId = undefined;
	state.planReviewPending = false;
	state.planReviewApproved = false;
	state.planReviewFeedback = undefined;
	state.planApproved = false;
	state.planApprovalSource = undefined;
	state.planActionPending = true;
	state.persistState();

	const reason = getPlannotatorUnavailableReason(
		response.status === "handled" ? "Plannotator review state could not be recovered." : response.error,
	);
	logPlannotatorUnavailable(`review recovery failed for review ${reviewId}`, reason);
	if (ctx.hasUI) {
		ctx.ui.notify(`${reason} Returning to the approval menu.`, "warning");
	}
}
