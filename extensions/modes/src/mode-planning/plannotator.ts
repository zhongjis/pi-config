import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildPlanExecutionGoal, requestDirectHandoffBridge } from "../../../handoff/runtime.js";
import type { ModeStateManager } from "../mode/mode-state.js";
import { PLANNOTATOR_REQUEST_CHANNEL, PLANNOTATOR_TIMEOUT_MS } from "./constants.js";
import { buildRefinementMessage } from "./plan-context.js";
import { getLocalPlanPath, LOCAL_PLAN_URI, readLocalPlanFile, writeLocalPlanFile } from "./plan-local.js";
import { hydratePlanState } from "./plan-storage.js";
import type {
	PlannotatorPlanReviewPayload,
	PlannotatorPlanReviewStartResult,
	PlannotatorResponse,
	PlannotatorReviewResultEvent,
	PlannotatorReviewStatusResult,
} from "./types.js";

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

/**
 * Check plannotator availability. Pass `forceProbe: true` to re-probe even
 * when availability was already cached as false (e.g., after a failed attempt
 * within the same session so the user can retry after fixing plannotator).
 */
async function checkPlannotatorAvailability(
	pi: ExtensionAPI,
	state: ModeStateManager,
	forceProbe = false,
): Promise<{ available: boolean; reason?: string }> {
	if (!forceProbe && typeof state.plannotatorAvailable === "boolean") {
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

	const reason = response.error;
	state.plannotatorAvailable = false;
	state.plannotatorUnavailableReason = getPlannotatorUnavailableReason(reason);
	logPlannotatorUnavailable("availability check failed", state.plannotatorUnavailableReason);
	return { available: false, reason: state.plannotatorUnavailableReason };
}

/**
 * Wire up the pending prepared handoff bridge so that `/handoff:start-work`
 * will succeed when the user (or agent) triggers it.
 * Returns an error string on failure, undefined on success.
 */
async function wireHandoffBridge(
	pi: ExtensionAPI,
	state: ModeStateManager,
	ctx: ExtensionContext,
): Promise<string | undefined> {
	const sessionFile = ctx.sessionManager.getSessionFile?.() ?? "";
	if (!sessionFile) {
		return "Current session file is unavailable — cannot prepare handoff.";
	}

	const planPath = getLocalPlanPath(ctx);
	const goal = buildPlanExecutionGoal(planPath);

	const reply = await requestDirectHandoffBridge(pi, {
		sessionFile,
		goal,
		mode: "houtu",
		summarize: true,
	});

	if (!reply.success) {
		return reply.error;
	}
	return undefined;
}

/**
 * Prepare the approved plan handoff: wire the bridge, set editor text, notify.
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

	// Wire the bridge so /handoff:start-work actually works
	const bridgeError = await wireHandoffBridge(pi, state, ctx);
	if (bridgeError) {
		console.error(`[modes/plannotator] wireHandoffBridge failed: ${bridgeError}`);
		// Still proceed — user can manually run /handoff
	}

	const completionMessage = buildCompletionMessage(state.planTitle);

	if (ctx.hasUI) {
		ctx.ui.setEditorText("/handoff:start-work");
		ctx.ui.notify(completionMessage, "info");
	}

	state.persistState();
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
		state.plannotatorAvailable = true;
		state.plannotatorUnavailableReason = undefined;
		state.persistState();
		return `Plan "${state.planTitle}" sent to Plannotator for refinement review.`;
	}

	state.pendingPlanReviewId = undefined;
	state.planReviewPending = false;
	state.planReviewApproved = false;
	state.planReviewFeedback = undefined;
	state.plannotatorAvailable = false;
	state.plannotatorUnavailableReason = getPlannotatorUnavailableReason(
		response.status === "handled" ? "Plannotator review could not be started." : response.error,
	);
	state.persistState();

	logPlannotatorUnavailable(`review start failed for plan "${state.planTitle}"`, state.plannotatorUnavailableReason);

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
		// status === "missing": the review no longer exists in plannotator (expired/restart)
		// Plannotator itself is fine — just clear our stale review state.
		state.pendingPlanReviewId = undefined;
		state.planReviewPending = false;
		state.planReviewApproved = false;
		state.planReviewFeedback = undefined;
		state.persistState();
		const missingMsg = "The pending Plannotator review no longer exists (it may have expired or plannotator was restarted). Returning to the approval menu.";
		console.warn(`[modes/plannotator] review recovery: review ${reviewId} is missing`);
		if (ctx.hasUI) {
			ctx.ui.notify(missingMsg, "warning");
		}
		return;
	}

	state.pendingPlanReviewId = undefined;
	state.planReviewPending = false;
	state.planReviewApproved = false;
	state.planReviewFeedback = undefined;
	state.persistState();

	const reason = getPlannotatorUnavailableReason(response.error);
	logPlannotatorUnavailable(`review recovery failed for review ${reviewId}`, reason);
	if (ctx.hasUI) {
		ctx.ui.notify(`${reason} Returning to the approval menu.`, "warning");
	}
}

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

// ─── Plan Approval Flow ───────────────────────────────────────────────────────

/**
 * Open the plan file directly in $VISUAL / $EDITOR.
 * Uses ctx.ui.custom() to obtain the tui handle, suspends the TUI,
 * spawns the editor with stdio inherited, then resumes.
 */
async function refineInSystemEditor(
	state: ModeStateManager,
	ctx: ExtensionContext,
): Promise<"edited" | "cancelled" | "no-ui"> {
	if (!ctx.hasUI) return "no-ui";

	const editorCmd = process.env.VISUAL || process.env.EDITOR || "vi";

	const currentContent = state.planContent ?? "";
	const tmpFile = path.join(os.tmpdir(), `pi-plan-edit-${Date.now()}.md`);

	try {
		fs.writeFileSync(tmpFile, currentContent, "utf-8");

		// Use ctx.ui.custom() to get the tui handle for stop/start
		const editResult = await ctx.ui.custom<"edited" | "cancelled">((tui, _theme, _keybindings, done) => {
			// Synchronous: suspend TUI, launch editor, resume — no deferral
			let outcome: "edited" | "cancelled" = "cancelled";
			try {
				tui.stop();
				// Enter alternate screen so editor output doesn't pollute scrollback
				process.stdout.write("\x1b[?1049h");
				const [editor, ...editorArgs] = editorCmd.split(" ");
				const result = spawnSync(editor, [...editorArgs, tmpFile], {
					stdio: "inherit",
					shell: process.platform === "win32",
				});

				if (result.status === 0) {
					const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
					if (newContent.trim() !== currentContent.trim()) {
						outcome = "edited";
					}
				}
			} catch {
				// editor failed — treat as cancelled
			} finally {
				// Exit alternate screen — restores pre-editor terminal content
				process.stdout.write("\x1b[?1049l");
				tui.start();
				tui.requestRender(true);
			}
			// Resolve after TUI is fully restored — avoids "Working..." flash
			done(outcome);

			// Placeholder component (never visible — TUI is stopped synchronously)
			return { width: 0, height: 0, draw() {} } as any;
		});

		if (editResult === "edited") {
			const updated = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
			await writeLocalPlanFile(ctx as any, updated);
			await hydratePlanState(ctx as any, state);
			state.persistState();
			return "edited";
		}
		return "cancelled";
	} finally {
		try { fs.unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
	}
	}


type ApprovalMenuVariant =
	| "post-gap-review"    // after gap review: Refine in Editor | Refine in Plannotator | High Accuracy Review | Approve
	| "post-high-accuracy"; // after yanluo: Refine in Editor | Refine in Plannotator | Approve

/**
 * Run the interactive plan approval flow.
 *
 * - "post-gap-review": shown after Di Renjie gap review finishes. Options:
 *     Refine in Editor | Refine in Plannotator | High Accuracy Review (Yan Luo) | Approve
 * - "post-high-accuracy": shown after Yan Luo returns OKAY. Options:
 *     Refine in Editor | Refine in Plannotator | Approve
 * Returns a string message for the agent describing what happened.
 */
export async function runPlanApprovalFlow(
	pi: ExtensionAPI,
	state: ModeStateManager,
	ctx: ExtensionContext,
	variant: ApprovalMenuVariant = "post-gap-review",
): Promise<string> {
	// Re-hydrate to ensure we have the latest plan content
	const snapshot = await hydratePlanState(ctx as any, state);
	if (!snapshot || !state.planTitle) {
		return `Error: No plan found in ${LOCAL_PLAN_URI}. Write or save the plan to ${LOCAL_PLAN_URI} first.`;
	}

	// Check plannotator availability (re-probe each time this menu is shown so
	// the option can be enabled if plannotator starts up between invocations)
	const plannotatorAvail = await checkPlannotatorAvailability(pi, state, /* forceProbe */ true);

	const plannotatorLabel = plannotatorAvail.available
		? "Refine in Plannotator"
		: `Refine in Plannotator (unavailable: ${getPlannotatorUnavailableReason(plannotatorAvail.reason)})`;

	const editorCmd = process.env.VISUAL || process.env.EDITOR || "vi";
	const editorName = path.basename(editorCmd.split(" ")[0]);
	const editorLabel = `Refine in System Editor (${editorName})`;

	// Build option list
	const OPTIONS_POST_GAP = [
		editorLabel,
		plannotatorLabel,
		"High Accuracy Review (Yan Luo)",
		"Approve",
	] as const;

	const OPTIONS_POST_HIGH_ACCURACY = [
		editorLabel,
		plannotatorLabel,
		"Approve",
	] as const;

	const options = variant === "post-gap-review" ? OPTIONS_POST_GAP : OPTIONS_POST_HIGH_ACCURACY;

	if (!ctx.hasUI) {
		// Non-interactive: auto-approve
		state.planReviewApproved = true;
		const handoffResult = await prepareApprovedPlanHandoff(pi, state, ctx);
		return handoffResult.message;
	}

	const selected = await ctx.ui.select(
		`Plan: "${state.planTitle}" — How would you like to proceed?`,
		[...options],
	);

	if (!selected) {
		return "Plan approval cancelled by user.";
	}

	// ── Approve ──────────────────────────────────────────────────────────────
	if (selected === "Approve") {
		state.planReviewApproved = true;
		const handoffResult = await prepareApprovedPlanHandoff(pi, state, ctx);
		if (!handoffResult.success) {
			return handoffResult.message;
		}
		return handoffResult.message;
	}

	// ── High Accuracy Review ─────────────────────────────────────────────────
	if (selected === "High Accuracy Review (Yan Luo)") {
		return [
			`Plan approval: user selected High Accuracy Review.`,
			`Run yanluo as a subagent with the plan content from ${LOCAL_PLAN_URI}.`,
			`Loop until yanluo returns OKAY. Fix every issue raised. No maximum retry limit.`,
			`After yanluo returns OKAY, call the plan_approve tool with variant "post-high-accuracy" to show the post-review approval menu.`,
		].join("\n");
	}

	// ── Refine in System Editor ───────────────────────────────────────────────
	if (selected.startsWith("Refine in System Editor")) {
		const editorResult = await refineInSystemEditor(state, ctx);
		if (editorResult === "cancelled") {
			// Re-show the same menu after cancellation
			return runPlanApprovalFlow(pi, state, ctx, variant);
		}
		if (editorResult === "no-ui") {
			return "Cannot open editor in non-interactive mode.";
		}
		// Plan updated — re-show the same menu with the updated content
		if (ctx.hasUI) {
			ctx.ui.notify(`Plan "${state.planTitle}" updated. Returning to approval menu.`, "info");
		}
		return runPlanApprovalFlow(pi, state, ctx, variant);
	}

	// ── Refine in Plannotator ─────────────────────────────────────────────────
	if (selected.startsWith("Refine in Plannotator")) {
		if (!plannotatorAvail.available) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Plannotator is unavailable: ${plannotatorAvail.reason}`, "warning");
			}
			// Re-show menu
			return runPlanApprovalFlow(pi, state, ctx, variant);
		}
		const reviewResult = await startPlanReview(pi, state, ctx);
		return reviewResult;
	}

	return "Plan approval: unrecognised selection.";
}
