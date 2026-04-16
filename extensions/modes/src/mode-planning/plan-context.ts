import type { ModeStateManager } from "../mode/mode-state.js";

export function buildPlanContextContent(state: ModeStateManager): string {
	if (!state.planContent) return "";
	const notes: string[] = [];
	const plannotatorNotes = state.planReviewApproved ? state.planReviewFeedback?.trim() : undefined;
	if (plannotatorNotes) notes.push(`[PLANNOTATOR NOTES]\n${plannotatorNotes}`);
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
