import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { PLANNOTATOR_REQUEST_CHANNEL, PLANNOTATOR_TIMEOUT_MS } from "./constants.js";
import { buildHighAccuracyReviewMessage, buildRefinementMessage } from "./plan-context.js";
import type { ModeStateManager } from "./mode-state.js";
import { getLocalPlanPath, LOCAL_PLAN_URI } from "./plan-local.js";
import { hydratePlanState } from "./plan-storage.js";
import type {
	PlannotatorPlanReviewPayload,
	PlannotatorPlanReviewStartResult,
	PlannotatorResponse,
	PlannotatorReviewResultEvent,
	PlannotatorReviewStatusResult,
} from "./types.js";

const PLANNOTATOR_AVAILABLE_LABEL = "Refine in Plannotator";
const PLANNOTATOR_UNAVAILABLE_LABEL = "Refine in Plannotator (unavailable)";
const PLANNOTATOR_HEALTH_SENTINEL_REVIEW_ID = "__plannotator_health_check__";

function getPlannotatorUnavailableReason(reason?: string): string {
	const trimmed = reason?.trim();
	return trimmed || "Plannotator is unavailable.";
}

function logPlannotatorUnavailable(scope: string, reason?: string): void {
	console.error(`[modes/plannotator] ${scope}: ${getPlannotatorUnavailableReason(reason)}`);
}

function buildCompletionMessage(title: string): string {
	return `Planning finished for "${title}", you can start work now by sending /handoff:start-work`;
}

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

export async function prepareApprovedPlanHandoff(
	_pi: ExtensionAPI,
	state: ModeStateManager,
	ctx: ExtensionContext,
): Promise<{ success: boolean; message: string; level: "info" | "warning"; details?: Record<string, unknown> }> {
	state.planActionPending = false;
	state.persistState();

	if (!state.planTitle) {
		return {
			success: false,
			message: `No finalized plan found in ${LOCAL_PLAN_URI}. Finalize the plan first.`,
			level: "warning",
		};
	}

	const planPath = getLocalPlanPath(ctx);
	const completionMessage = buildCompletionMessage(state.planTitle);

	if (ctx.hasUI) {
		ctx.ui.setEditorText("/handoff:start-work");
		ctx.ui.notify(completionMessage, "info");
	}

	return {
		success: true,
		message: completionMessage,
		level: "info",
		details: {
			planTitle: state.planTitle,
			planPath,
			mode: "houtu",
		},
	};
}

export async function promptPostPlanAction(pi: ExtensionAPI, state: ModeStateManager, ctx: ExtensionContext): Promise<void> {
	if (state.currentMode !== "fuxi" || !ctx.hasUI) return;
	const snapshot = await hydratePlanState(ctx as any, state);
	if (!snapshot || !state.planTitle || !state.planActionPending || state.hasPendingReview()) return;

	const title = state.planTitle;
	const plannotator = await checkPlannotatorAvailability(pi, state);
	const plannotatorLabel = plannotator.available ? PLANNOTATOR_AVAILABLE_LABEL : PLANNOTATOR_UNAVAILABLE_LABEL;

	const choices = [
		"Approve",
		"Refine in System Editor ($EDITOR)",
		plannotatorLabel,
		"High accuracy review",
	];

	const choice = await ctx.ui.select(`Plan "${title}" finalized — choose an action:`, choices);
	if (!choice) return;

	if (choice === "Approve") {
		state.planApproved = true;
		state.planApprovalSource = "user";
		state.planActionPending = false;
		state.persistState();
		ctx.ui.setEditorText("/handoff:start-work");
		pi.sendUserMessage(buildCompletionMessage(title), { deliverAs: "followUp" });
		return;
	}

	if (choice === "Refine in System Editor ($EDITOR)") {
		const editor = process.env.VISUAL || process.env.EDITOR || "vi";
		const planPath = getLocalPlanPath(ctx);
		const result = spawnSync(editor, [planPath], { stdio: "inherit" });
		if (result.status !== 0 && result.error) {
			ctx.ui.notify(`Editor failed to open: ${result.error.message}`, "warning");
		}
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
		await hydratePlanState(ctx as any, state);
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

		let completionMessage: string;
		if (ctx) {
			const handoffResult = await prepareApprovedPlanHandoff(pi, state, ctx);
			completionMessage = handoffResult.message;
		} else {
			state.planActionPending = false;
			state.persistState();
			completionMessage = buildCompletionMessage(state.planTitle ?? "untitled");
		}
		pi.sendUserMessage(completionMessage, { deliverAs: "followUp" });
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
	const snapshot = await hydratePlanState(ctx as any, state);
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

	await hydratePlanState(ctx as any, state);

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
