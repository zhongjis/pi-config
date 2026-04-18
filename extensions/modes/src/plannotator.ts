/**
 * Plannotator integration — direct browser review without IPC.
 *
 * Calls startPlanReviewBrowserSession directly from the installed plannotator
 * git package instead of emitting events through a channel.  This eliminates
 * the 5-second timeout race and the dependency on plannotator's session_start
 * listener being registered first.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { requestDirectHandoffBridge, buildPlanExecutionGoal } from "../../handoff/runtime.js";
import type { ModeStateManager } from "./mode-state.js";
import { LOCAL_PLAN_URI } from "./constants.js";
import { getLocalPlanPath, hydratePlanState } from "./plan-storage.js";
import { isPlannotatorAvailable, startDirectPlanReview, resetPlannotatorCache } from "./plannotator-direct.js";
import type { PlannotatorReviewResultEvent } from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

export function getPlannotatorUnavailableReason(reason?: string): string {
	const trimmed = reason?.trim();
	return trimmed || "Plannotator is unavailable.";
}

function logPlannotatorUnavailable(scope: string, reason?: string): void {
	console.error(`[modes/plannotator] ${scope}: ${getPlannotatorUnavailableReason(reason)}`);
}

function buildCompletionMessage(title: string): string {
	return `Planning finished for "${title}", you can start work now by sending /handoff:start-work`;
}

function buildRefinementMessage(state: ModeStateManager): string {
	const feedback = state.planReviewFeedback?.trim();
	if (feedback) {
		return `Plannotator review feedback:\n${feedback}\n\nPlease revise the current plan and resubmit it.`;
	}
	return "Plannotator review was rejected with no specific feedback. Please review the plan and revise it as needed, then resubmit.";
}

// ── Availability check (direct, no IPC) ─────────────────────────────────────

/**
 * Check plannotator availability via direct import probe.
 * Pass `forceProbe: true` to re-probe even when cached as unavailable.
 */
export async function checkPlannotatorAvailability(
	_pi: ExtensionAPI,
	state: ModeStateManager,
	forceProbe = false,
): Promise<{ available: boolean; reason?: string }> {
	if (!forceProbe && typeof state.plannotatorAvailable === "boolean") {
		return {
			available: state.plannotatorAvailable,
			reason: state.plannotatorUnavailableReason,
		};
	}

	if (forceProbe) {
		resetPlannotatorCache();
	}

	const result = await isPlannotatorAvailable();

	state.plannotatorAvailable = result.available;
	state.plannotatorUnavailableReason = result.available ? undefined : getPlannotatorUnavailableReason(result.reason);

	if (!result.available) {
		logPlannotatorUnavailable("availability check", state.plannotatorUnavailableReason);
	}
	return result;
}

// ── Approved plan handoff ───────────────────────────────────────────────────

/**
 * Prepare the approved plan handoff: set editor text and notify.
 * Single persist at the end — callers must NOT persist before calling this.
 */
export async function prepareApprovedPlanHandoff(
	pi: ExtensionAPI,
	state: ModeStateManager,
	ctx: ExtensionContext,
): Promise<{ success: boolean; message: string; level: "info" | "warning"; details?: Record<string, unknown> }> {
	if (!state.planTitle) {
		state.persistState();
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

	state.persistState();

	// Register prepared handoff via direct bridge so /handoff:start-work
	// finds it even if in-memory resolver state is stale.
	const sessionFile = ctx.sessionManager?.getSessionFile?.();
	if (sessionFile) {
		const bridgeResult = await requestDirectHandoffBridge(pi, {
			sessionFile,
			goal: buildPlanExecutionGoal(planPath),
			mode: "houtu",
			summarize: false,
			source: "prepareApprovedPlanHandoff",
		});
		if (!bridgeResult.success) {
			console.error("[modes/plannotator] Handoff bridge registration failed:", bridgeResult.error);
		}
	}

	return {
		success: true,
		message: completionMessage,
		level: "info" as const,
		details: {
			planTitle: state.planTitle,
			planPath,
			mode: "houtu",
		},
	};
}

// ── Handle review result (from onDecision callback) ─────────────────────────

export async function handlePlanReviewResult(
	pi: ExtensionAPI,
	state: ModeStateManager,
	result: PlannotatorReviewResultEvent,
	ctx?: ExtensionContext,
): Promise<void> {
	if (!state.pendingPlanReviewId || result.reviewId !== state.pendingPlanReviewId) return;

	// Hydrate plan state from disk when ctx is available (may have changed while review was pending)
	const resolvedCtx = ctx ?? state.activeCtx;
	if (resolvedCtx) {
		await hydratePlanState(resolvedCtx as any, state);
	}

	state.pendingPlanReviewId = undefined;
	state.planReviewPending = false;
	state.planReviewFeedback = result.feedback?.trim() || undefined;

	if (result.approved) {
		state.planReviewApproved = true;
		// Do NOT persist here — prepareApprovedPlanHandoff persists at the end

		let completionMessage: string;
		if (resolvedCtx) {
			const handoffResult = await prepareApprovedPlanHandoff(pi, state, resolvedCtx);
			completionMessage = handoffResult.message;
		} else {
			completionMessage = buildCompletionMessage(state.planTitle ?? "untitled");
			state.persistState();
		}
		pi.sendUserMessage(completionMessage, { deliverAs: "followUp" });
		return;
	}

	state.planReviewApproved = false;
	state.persistState();
	if (resolvedCtx?.hasUI) {
		resolvedCtx.ui.notify(`Plan "${state.planTitle ?? "untitled"}" needs refinement.`, "warning");
	}
	if (state.currentMode === "fuxi") {
		pi.sendUserMessage(buildRefinementMessage(state), { deliverAs: "followUp" });
	}
}

// ── Start plan review (direct browser session) ─────────────────────────────

export async function startPlanReview(pi: ExtensionAPI, state: ModeStateManager, ctx: ExtensionContext): Promise<string> {
	const snapshot = await hydratePlanState(ctx as any, state);
	if (!snapshot || !state.planTitle) {
		return `Error: No plan found in ${LOCAL_PLAN_URI}. Write or save the plan to ${LOCAL_PLAN_URI} first.`;
	}

	try {
		const session = await startDirectPlanReview(ctx, snapshot.content);

		state.pendingPlanReviewId = session.reviewId;
		state.planReviewPending = true;
		state.planReviewApproved = false;
		state.planReviewFeedback = undefined;
		state.plannotatorAvailable = true;
		state.plannotatorUnavailableReason = undefined;
		state.persistState();

		// Wire the onDecision callback → handlePlanReviewResult
		session.onDecision(async (decision) => {
			await handlePlanReviewResult(pi, state, {
				reviewId: session.reviewId,
				approved: decision.approved,
				feedback: decision.feedback,
			}, state.activeCtx);
		});

		return `Plan "${state.planTitle}" sent to Plannotator for refinement review.`;
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		state.pendingPlanReviewId = undefined;
		state.planReviewPending = false;
		state.planReviewApproved = false;
		state.planReviewFeedback = undefined;
		state.plannotatorAvailable = false;
		state.plannotatorUnavailableReason = getPlannotatorUnavailableReason(reason);
		state.persistState();

		logPlannotatorUnavailable(`review start failed for plan "${state.planTitle}"`, reason);

		if (ctx.hasUI) {
			ctx.ui.notify(`${state.plannotatorUnavailableReason} Returning to the approval menu.`, "warning");
		}
		return `Plannotator review could not be started for plan "${state.planTitle}". Returning to the approval menu.`;
	}
}

// ── Recover pending review on session restart ───────────────────────────────

export async function recoverPlanReview(pi: ExtensionAPI, state: ModeStateManager, ctx: ExtensionContext): Promise<void> {
	if (!state.pendingPlanReviewId) return;

	// On session restart, any pending browser review is lost (server stopped).
	// Clear stale review state so user can start fresh.
	const reviewId = state.pendingPlanReviewId;
	console.warn(`[modes/plannotator] review recovery: clearing stale review ${reviewId} (browser session lost on restart)`);

	state.pendingPlanReviewId = undefined;
	state.planReviewPending = false;
	state.planReviewApproved = false;
	state.planReviewFeedback = undefined;
	state.persistState();

	if (ctx.hasUI) {
		ctx.ui.notify("Previous Plannotator review session was lost (session restarted). You can start a new review from the approval menu.", "warning");
	}
}

// ── Convenience: check + start ──────────────────────────────────────────────

export async function checkAndStartPlannotatorReview(
	pi: ExtensionAPI,
	state: ModeStateManager,
	ctx: ExtensionContext,
	forceProbe = false,
): Promise<string> {
	const availability = await checkPlannotatorAvailability(pi, state, forceProbe);
	if (!availability.available) {
		return `Plannotator unavailable: ${getPlannotatorUnavailableReason(availability.reason)}`;
	}
	return startPlanReview(pi, state, ctx);
}
