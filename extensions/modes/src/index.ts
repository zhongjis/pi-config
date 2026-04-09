/**
 * Agent Modes Extension
 *
 * Three personas — Kua Fu 夸父 (build), Fu Xi 伏羲 (plan), Hou Tu 后土 (execute).
 * Default: Kua Fu. Switch via /mode, --mode flag, Tab, or Ctrl+Shift+M.
 *
 * Each mode reads its prompt from agents/<mode>.md (same files used by subagent).
 * AGENTS.md global rules stay active in all modes.
 *
 * Plan flow:
 *   Fu Xi drafts plan with Di Renjie gap review before save
 *   exit_plan_mode finalizes + returns the post-plan action menu
 *   Optional Plannotator refine and optional Yanluo high-accuracy review stay user-driven
 *   Execute → Hou Tu mode, plan injected via before_agent_start
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { PLANNOTATOR_REVIEW_RESULT_CHANNEL } from "./constants.js";
import { registerModeCommands } from "./commands.js";
import { registerModeHooks } from "./hooks.js";
import { ModeStateManager } from "./mode-state.js";
import { registerPlanTools } from "./plan-tools.js";
import { handlePlanReviewResult } from "./plannotator.js";
import type { PlannotatorReviewResultEvent } from "./types.js";

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

	registerPlanTools(pi, state);
	registerModeCommands(pi, state);
	registerModeHooks(pi, state);
}
