import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { buildHighAccuracyRefinementMessage } from "./plan-context.js";
import type { ModeStateManager } from "./mode-state.js";
import { promptPostPlanAction } from "./plannotator.js";
import type { PlanEntry } from "./types.js";

export function registerPlanTools(pi: ExtensionAPI, state: ModeStateManager): void {
	pi.registerTool({
		name: "plan_write",
		label: "PlanWrite",
		description: "Save a plan to the session. Use in Fu Xi (plan) mode to store the plan before calling exit_plan_mode.",
		parameters: Type.Object({
			content: Type.String({ description: "Full plan content in markdown" }),
		}),
		async execute(_toolCallId, params) {
			state.planContent = params.content;
			state.planTitle = undefined; // draft until exit_plan_mode
			state.resetPlanReviewState();
			pi.appendEntry<PlanEntry>("plan", { content: params.content, draft: true });

			return {
				content: [{ type: "text", text: "Plan saved to session. Call exit_plan_mode with a title when ready." }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "exit_plan_mode",
		label: "ExitPlanMode",
		description:
			"Finalize the plan and signal completion. You MUST call plan_write first. Provide a short title for the plan.",
		parameters: Type.Object({
			title: Type.String({ description: "Short plan title, e.g. AUTH_REFACTOR" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state.planContent) {
				return {
					content: [{ type: "text", text: "Error: No plan found. Call plan_write first." }],
					details: {},
					isError: true,
				};
			}

			const trimmed = params.title.trim().replace(/\.md$/i, "");
			if (!trimmed || /[/\\]/.test(trimmed)) {
				return {
					content: [{ type: "text", text: "Error: Title must be non-empty without path separators." }],
					details: {},
					isError: true,
				};
			}

			state.planTitle = trimmed;
			state.planActionPending = true;
			pi.appendEntry<PlanEntry>("plan", { title: trimmed, content: state.planContent, draft: false });
			state.persistState();
			return {
				content: [{ type: "text", text: `Plan "${trimmed}" saved. Choose what to do next.` }],
				details: { title: trimmed, planActionPending: state.planActionPending },
			};
		},
	});

 	pi.registerTool({
		name: "high_accuracy_review_complete",
		label: "HighAccuracyReviewComplete",
		description: "Record the result of an explicit Yanluo high accuracy review for the current saved plan.",
		parameters: Type.Object({
			approved: Type.Boolean({ description: "Whether Yanluo approved the current saved plan" }),
			feedback: Type.Optional(Type.String({ description: "Yanluo review feedback or notes" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state.planContent || !state.planTitle) {
				return {
					content: [{ type: "text", text: "Error: No saved plan found." }],
					details: {},
					isError: true,
				};
			}

			state.highAccuracyReviewPending = false;
			state.highAccuracyReviewApproved = params.approved;
			state.highAccuracyReviewFeedback = params.feedback?.trim() || undefined;

			if (params.approved) {
				state.planActionPending = true;
				state.persistState();
				if (ctx.hasUI) {
					ctx.ui.notify(`Plan "${state.planTitle}" approved in high accuracy review.`, "info");
				}
				await promptPostPlanAction(pi, state, ctx);
				return {
					content: [{ type: "text", text: `High accuracy review approved for plan "${state.planTitle}".` }],
					details: { approved: true },
				};
			}

			state.planActionPending = false;
			state.persistState();
			if (ctx.hasUI) {
				ctx.ui.notify(`Plan "${state.planTitle}" needs revision after high accuracy review.`, "warning");
			}
			if (state.currentMode === "fuxi") {
				pi.sendUserMessage(buildHighAccuracyRefinementMessage(state));
			}
			return {
				content: [{ type: "text", text: `High accuracy review feedback recorded for plan "${state.planTitle}".` }],
				details: { approved: false },
			};
		},
	});

	pi.registerTool({
		name: "plan_read",
		label: "PlanRead",
		description:
			"Read the current plan from the session. Fallback for post-compaction or manual Hou Tu entry. In normal Fu Xi → Hou Tu flow the plan is injected automatically.",
		parameters: Type.Object({}),
		async execute() {
			if (state.planContent) {
				return {
					content: [
						{
							type: "text",
							text: state.planTitle ? `# Plan: ${state.planTitle}\n\n${state.planContent}` : state.planContent,
						},
					],
					details: {},
				};
			}
			return {
				content: [{ type: "text", text: "No plan found in session." }],
				details: {},
				isError: true,
			};
		},
	});
}
