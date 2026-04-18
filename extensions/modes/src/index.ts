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
 *   plan_approve tool presents Approve / High Accuracy Review / Refine choices
 *   Approved plan prepares Hou Tu handoff via /handoff:start-work
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { buildPlanExecutionGoal, setPreparedHandoffArgsResolver } from "../../handoff/runtime.js";
import { registerModeCommands } from "./commands.js";
import { registerModeHooks } from "./hooks.js";
import { ModeStateManager } from "./mode-state.js";
import { runPlanApprovalFlow } from "./plan-approval.js";
import { getLocalPlanPath } from "./plan-storage.js";
export default function modesExtension(pi: ExtensionAPI): void {
	const state = new ModeStateManager(pi);

	// Fallback args resolver so /handoff:start-work can derive
	// handoff args from persisted mode state (survives pi restart).
	setPreparedHandoffArgsResolver((ctx) => {
		if (state.currentMode !== "fuxi" || !state.planReviewApproved || !state.planTitle) {
			return null;
		}
		const planPath = getLocalPlanPath(ctx as any);
		return {
			goal: buildPlanExecutionGoal(planPath),
			mode: "houtu",
			summarize: false,
		};
	});

	// plan_approve tool (absorbed from tools.ts)
	pi.registerTool({
		name: "plan_approve",
		label: "Plan Approve",
		description:
			"Present the plan approval menu after plan generation is complete. " +
			"Shows interactive options: Approve, High Accuracy Review (Yan Luo), Refine in Editor, Refine in Plannotator. " +
			"Use variant 'post-gap-review' (default) after Di Renjie gap review, or 'post-high-accuracy' after Yan Luo returns OKAY.",
		parameters: Type.Object({
			variant: Type.Optional(
				Type.Union([Type.Literal("post-gap-review"), Type.Literal("post-high-accuracy")], {
					description:
						'Approval menu variant. "post-gap-review" (default) includes High Accuracy Review option. ' +
						'"post-high-accuracy" omits it (used after Yan Luo already approved).',
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const variant = params.variant === "post-high-accuracy" ? "post-high-accuracy" as const : "post-gap-review" as const;
			const result = await runPlanApprovalFlow(pi, state, ctx, variant);
			return {
				content: [{ type: "text" as const, text: result }],
			};
		},
	});

	registerModeCommands(pi, state);
	registerModeHooks(pi, state);
}
