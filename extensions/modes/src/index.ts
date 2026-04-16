/**
 * Agent Modes Extension
 *
 * Three personas — Kua Fu 夸父 (build), Fu Xi 伏羲 (plan), Hou Tu 后土 (execute).
 * Default: Kua Fu. Switch via /mode, --mode flag, Tab, or Ctrl+Shift+M.
 *
 * Each mode reads its prompt from agents/<mode>.md (same files used by subagent).
 * AGENTS.md global rules stay active in all modes.
 *
 * Plan flow (OMO-style):
 *   Fu Xi drafts plan with Di Renjie gap review
 *   Agent-driven ask presents Start Work vs High Accuracy Review choice
 *   Approved plan prepares Hou Tu handoff via /handoff:start-work
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerModeCommands } from "./mode/commands.js";
import { registerModeHooks } from "./mode/hooks.js";
import { ModeStateManager } from "./mode/mode-state.js";
import { PLANNOTATOR_REVIEW_RESULT_CHANNEL } from "./mode-planning/constants.js";
import { handlePlanReviewResult } from "./mode-planning/plannotator.js";
import type { PlannotatorReviewResultEvent } from "./mode-planning/types.js";

export default function modesExtension(pi: ExtensionAPI): void {
	const state = new ModeStateManager(pi);

	// Plannotator review result listener — reads state.activeCtx at event time
	pi.events.on(PLANNOTATOR_REVIEW_RESULT_CHANNEL, async (data) => {
		const result = data as Partial<PlannotatorReviewResultEvent> | null;
		if (!result || typeof result.reviewId !== "string" || typeof result.approved !== "boolean") return;
		await handlePlanReviewResult(pi, state, {
			reviewId: result.reviewId,
			approved: result.approved,
			feedback: typeof result.feedback === "string" ? result.feedback : undefined,
		}, state.activeCtx);
	});

	registerModeCommands(pi, state);
	registerModeHooks(pi, state);
}
