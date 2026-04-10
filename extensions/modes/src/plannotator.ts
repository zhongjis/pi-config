import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { PLANNOTATOR_REQUEST_CHANNEL, PLANNOTATOR_TIMEOUT_MS } from "./constants.js";
import { buildHighAccuracyReviewMessage, buildRefinementMessage } from "./plan-context.js";
import type { ModeStateManager } from "./mode-state.js";
import type {
	PlannotatorPlanReviewPayload,
	PlannotatorPlanReviewStartResult,
	PlannotatorResponse,
	PlannotatorReviewResultEvent,
	PlannotatorReviewStatusResult,
} from "./types.js";

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

export async function promptPostPlanAction(pi: ExtensionAPI, state: ModeStateManager, ctx: ExtensionContext): Promise<void> {
	if (state.currentMode !== "fuxi" || !ctx.hasUI) return;
	if (!state.planContent || !state.planTitle || !state.planActionPending || state.hasPendingReview()) return;

	const choices: string[] = ["Execute"];
	if (!state.planReviewApproved) {
		choices.push("Refine in Plannotator");
	}
	if (!state.highAccuracyReviewApproved) {
		choices.push("High accuracy review");
	}

	const choice = await ctx.ui.select(`Plan "${state.planTitle}" ready. What next?`, choices);
	if (!choice) return;

	if (choice === "Execute") {
		state.planActionPending = false;
		state.persistState();
		state.justSwitchedToHoutu = true;
		state.switchMode("houtu", ctx);
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
	if (!state.planContent || !state.planTitle) {
		return "Error: No plan found. Call plan_write first.";
	}

	const response = await requestPlannotator<PlannotatorPlanReviewStartResult>(pi, "plan-review", {
		planContent: state.planContent,
		origin: "fuxi-explicit-refine",
	} satisfies PlannotatorPlanReviewPayload);

	if (response.status === "handled" && response.result.status === "pending") {
		state.pendingPlanReviewId = response.result.reviewId;
		state.planReviewPending = true;
		state.planReviewApproved = false;
		state.planReviewFeedback = undefined;
		state.planActionPending = false;
		state.persistState();
		return `Plan "${state.planTitle}" sent to Plannotator for refinement review.`;
	}

	state.pendingPlanReviewId = undefined;
	state.planReviewPending = false;
	state.planReviewApproved = false;
	state.planReviewFeedback = undefined;
	state.planActionPending = true;
	state.persistState();

	const reason = response.status === "handled" ? "Plannotator review could not be started." : response.error;
	if (reason && ctx.hasUI) {
		ctx.ui.notify(`${reason} Returning to the post-plan menu.`, "warning");
	}
	return `Plannotator review could not be started for plan "${state.planTitle}". Returning to the post-plan menu.`;
}

export async function recoverPlanReview(pi: ExtensionAPI, state: ModeStateManager, ctx: ExtensionContext): Promise<void> {
	if (!state.pendingPlanReviewId) return;

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
