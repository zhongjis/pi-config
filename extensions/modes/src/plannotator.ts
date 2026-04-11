import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { PLANNOTATOR_REQUEST_CHANNEL, PLANNOTATOR_TIMEOUT_MS } from "./constants.js";
import { buildHighAccuracyReviewMessage, buildRefinementMessage } from "./plan-context.js";
import type { ModeStateManager } from "./mode-state.js";
import { hydratePlanState, LOCAL_PLAN_URI } from "./plan-storage.js";
import type {
	PlannotatorPlanReviewPayload,
	PlannotatorPlanReviewStartResult,
	PlannotatorResponse,
	PlannotatorReviewResultEvent,
	PlannotatorReviewStatusResult,
} from "./types.js";

const HANDOFF_TASK_CLEANUP_CHANNEL = "tasks:rpc:clear-planning-tasks";
const HANDOFF_TASK_CLEANUP_TIMEOUT_MS = 1_500;
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

type HandoffCleanupNotification = {
	message: string;
	level: "info" | "warning";
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
	state.plannotatorUnavailableReason = reason ?? "Plannotator is unavailable.";
	return { available: false, reason: state.plannotatorUnavailableReason };
}

async function clearPlanningTasksForHandoff(pi: ExtensionAPI, sessionId: string): Promise<HandoffCleanupNotification> {
	const requestId = `clear-planning-tasks-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const replyChannel = `${HANDOFF_TASK_CLEANUP_CHANNEL}:reply:${requestId}`;
	const fallback: HandoffCleanupNotification = {
		message: "Switched to Hou Tu. Planning-task cleanup unavailable.",
		level: "warning",
	};

	return await new Promise<HandoffCleanupNotification>((resolve) => {
		let settled = false;
		let unsubscribe = () => {};
		const finish = (notification: HandoffCleanupNotification) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			unsubscribe();
			resolve(notification);
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
				const message = reply.data.removedIncomplete > 0
					? `Cleared ${reply.data.removed} planning tasks (${reply.data.removedIncomplete} incomplete) and switched to Hou Tu.`
					: `Cleared ${reply.data.removed} planning tasks and switched to Hou Tu.`;
				finish({
					message,
					level: "info",
				});
				return;
			}

			if (reply.data.status === "already_clean") {
				finish({
					message: "Switched to Hou Tu. No planning tasks to clean.",
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

export async function promptPostPlanAction(pi: ExtensionAPI, state: ModeStateManager, ctx: ExtensionContext): Promise<void> {
	if (state.currentMode !== "fuxi" || !ctx.hasUI) return;
	const snapshot = await hydratePlanState(ctx, state);
	if (!snapshot || !state.planTitle || !state.planActionPending || state.hasPendingReview()) return;

	const choices: string[] = ["Execute in Hou Tu"];
	if (!state.planReviewApproved) {
		const plannotator = await checkPlannotatorAvailability(pi, state);
		if (plannotator.available) {
			choices.push("Refine in Plannotator");
		}
	}
	if (!state.highAccuracyReviewApproved) {
		choices.push("High accuracy review");
	}

	const choice = await ctx.ui.select(`Plan "${state.planTitle}" ready. What next?`, choices);
	if (!choice) return;

	if (choice === "Execute in Hou Tu") {
		state.planActionPending = false;
		state.persistState();
		const cleanupNotification = await clearPlanningTasksForHandoff(pi, ctx.sessionManager.getSessionId());
		state.justSwitchedToHoutu = true;
		state.switchMode("houtu", ctx);
		ctx.ui.notify(cleanupNotification.message, cleanupNotification.level);
		// Defer to next event-loop tick so finishRun() clears isStreaming before
		// the message is sent. Without this, sendUserMessage sees isStreaming=true
		// (still inside agent_end), queues a follow-up that the already-exited
		// agent loop never drains — the turn silently never starts.
		setTimeout(() => pi.sendUserMessage(`Execute the plan: ${state.planTitle}`), 0);
		return;
	}

	if (choice === "Refine in Plannotator") {
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

	if (choice === "High accuracy review") {
		state.highAccuracyReviewPending = true;
		state.highAccuracyReviewApproved = false;
		state.highAccuracyReviewFeedback = undefined;
		state.planActionPending = false;
		state.persistState();
		setTimeout(() => pi.sendUserMessage(buildHighAccuracyReviewMessage(state)), 0);
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
		state.planActionPending = true;
		state.persistState();
		if (ctx?.hasUI) {
			ctx.ui.notify(`Plan "${state.planTitle ?? "untitled"}" approved in Plannotator.`, "info");
		}
		if (ctx) {
			await promptPostPlanAction(pi, state, ctx);
		}
		return;
	}

	state.planReviewApproved = false;
	state.planActionPending = false;
	state.persistState();
	if (ctx?.hasUI) {
		ctx.ui.notify(`Plan "${state.planTitle ?? "untitled"}" needs refinement in Plannotator.`, "warning");
	}
	if (state.currentMode === "fuxi") {
		pi.sendUserMessage(buildRefinementMessage(state));
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
	state.planActionPending = true;
	state.persistState();
	state.plannotatorAvailable = false;
	state.plannotatorUnavailableReason = response.status === "handled" ? "Plannotator review could not be started." : response.error;

	const reason = response.status === "handled" ? "Plannotator review could not be started." : response.error;
	if (reason && ctx.hasUI) {
		ctx.ui.notify(`${reason} Returning to the post-plan menu.`, "warning");
	}
	return `Plannotator review could not be started for plan "${state.planTitle}". Returning to the post-plan menu.`;
}

export async function recoverPlanReview(pi: ExtensionAPI, state: ModeStateManager, ctx: ExtensionContext): Promise<void> {
	if (!state.pendingPlanReviewId) return;

	await hydratePlanState(ctx, state);

	const response = await requestPlannotator<PlannotatorReviewStatusResult>(pi, "review-status", {
		reviewId: state.pendingPlanReviewId,
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
	state.planActionPending = true;
	state.persistState();

	const reason = response.status === "handled" ? "Plannotator review state could not be recovered." : response.error;
	if (reason && ctx.hasUI) {
		ctx.ui.notify(`${reason} Returning to the post-plan menu.`, "warning");
	}
}
