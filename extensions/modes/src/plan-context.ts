import { getPreparedHandoffCommand } from "../../handoff/src/runtime.js";
import type { ModeStateManager } from "./mode-state.js";
import { formatPlanDisplay } from "./plan-storage.js";

export function buildPlanContextContent(state: ModeStateManager): string {
	if (!state.planContent) return "";
	const notes: string[] = [];
	const plannotatorNotes = state.planReviewApproved ? state.planReviewFeedback?.trim() : undefined;
	const highAccuracyNotes = state.highAccuracyReviewApproved ? state.highAccuracyReviewFeedback?.trim() : undefined;
	if (plannotatorNotes) notes.push(`[PLANNOTATOR NOTES]\n${plannotatorNotes}`);
	if (highAccuracyNotes) notes.push(`[HIGH ACCURACY REVIEW NOTES]\n${highAccuracyNotes}`);
	return notes.length > 0
		? `[ACTIVE PLAN: ${state.planTitle ?? "untitled"}]\n\n${state.planContent}\n\n${notes.join("\n\n")}`
		: `[ACTIVE PLAN: ${state.planTitle ?? "untitled"}]\n\n${state.planContent}`;
}

export function buildRefinementMessage(state: ModeStateManager): string {
	const feedback = state.planReviewFeedback?.trim();
	if (feedback) {
		return `Plannotator review feedback:\n${feedback}\n\nPlease revise the current plan and resubmit it.`;
	}
	return "Please revise the current plan based on the Plannotator review feedback and resubmit it.";
}

export function buildHighAccuracyReviewMessage(state: ModeStateManager): string {
	if (!state.planContent) {
		return "High accuracy review could not start because no saved plan is available. Return to the approval menu.";
	}
	const planText = formatPlanDisplay({ title: state.planTitle, content: state.planContent });
	const handoffCommand = getPreparedHandoffCommand();
	return `Run High accuracy review on the current saved plan. Use the Agent tool to spawn \`yanluo\` with ONLY the plan text below as the prompt and \`inherit_context: false\`. Do not pass the planning transcript or reviewer chatter. When the review completes, call \`high_accuracy_review_complete\` with approved=true/false and the full feedback text. Do not call \`finalize_plan\` or \`exit_plan_mode\`. Do not execute the plan directly. Approved high-accuracy review will prepare Hou Tu handoff and prefill \`${handoffCommand}\` for explicit submission when UI is available. Do not rerun the review automatically.\n\n${planText}`;
}

export function buildHighAccuracyRefinementMessage(state: ModeStateManager): string {
	const feedback = state.highAccuracyReviewFeedback?.trim();
	if (feedback) {
		return `Yanluo high accuracy review feedback:\n${feedback}\n\nPlease revise the current plan in chat, then resave it before requesting another high accuracy review.`;
	}
	return "Yanluo requested revisions. Please revise the current plan in chat, then resave it before requesting another high accuracy review.";
}
