import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { runPlanApprovalFlow } from "../mode-planning/plannotator.js";
import type { ModeStateManager } from "./mode-state.js";

export function registerModeTools(pi: ExtensionAPI, state: ModeStateManager): void {
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
}
