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
		description: "Persist plan markdown and metadata to session state. Use in Fu Xi mode for draft checkpoints and final pre-exit saves.",
		parameters: Type.Object({
			content: Type.String({ description: "Full plan content in markdown" }),
			name: Type.Optional(Type.String({ description: "Optional short plan name/title to persist with this save" })),
			isDraft: Type.Optional(Type.Boolean({ description: "Whether this save is a draft checkpoint. Defaults to true." })),
		}),
		async execute(_toolCallId, params) {
			const isDraft = params.isDraft ?? true;
			const rawName = typeof params.name === "string" ? params.name.trim().replace(/\.md$/i, "") : "";
			if (rawName && /[/\\]/.test(rawName)) {
				return {
					content: [{ type: "text", text: "Error: Name must not contain path separators." }],
					details: {},
					isError: true,
				};
			}

			state.planContent = params.content;
			state.planTitle = rawName || state.planTitle;
			state.resetPlanReviewState();
			pi.appendEntry<PlanEntry>("plan", {
				title: state.planTitle,
				content: params.content,
				draft: isDraft,
			});

			return {
				content: [{ type: "text", text: isDraft ? `Draft${state.planTitle ? ` \"${state.planTitle}\"` : ""} saved to session state. Re-run Di Renjie gap review on the latest saved draft before exit_plan_mode.` : `Plan${state.planTitle ? ` \"${state.planTitle}\"` : ""} saved to session state. Call exit_plan_mode when you are ready for the post-plan action menu.` }],
				details: { title: state.planTitle, draft: isDraft },
			};
		},
	});


	pi.registerTool({
		name: "gap_review_complete",
		label: "GapReviewComplete",
		description: "Record the result of the latest Di Renjie gap review for the current saved draft.",
		parameters: Type.Object({
			approved: Type.Boolean({ description: "Whether Di Renjie cleared the latest saved draft for finalize" }),
			feedback: Type.Optional(Type.String({ description: "Di Renjie review feedback or watchouts" })),
		}),
		async execute(_toolCallId, params) {
			if (!state.planContent) {
				return {
					content: [{ type: "text", text: "Error: No saved draft found. Call plan_write first." }],
					details: {},
					isError: true,
				};
			}

			state.gapReviewApproved = params.approved;
			state.gapReviewFeedback = params.feedback?.trim() || undefined;
			state.persistState();

			return {
				content: [{ type: "text", text: params.approved ? "Gap review cleared for the latest saved draft." : "Gap review feedback recorded for the latest saved draft." }],
				details: { approved: params.approved },
			};
		},
	});

	pi.registerTool({
		name: "exit_plan_mode",
		label: "ExitPlanMode",
		description:
			"Finalize the plan and signal completion. You MUST call plan_write first, then clear the latest saved draft through gap_review_complete before exiting plan mode. Provide a short title here, or persist one earlier with plan_write(name=...).",
		parameters: Type.Object({
			title: Type.Optional(Type.String({ description: "Optional short plan title. If omitted, the latest saved plan_write name is used." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!state.planContent) {
				return {
					content: [{ type: "text", text: "Error: No plan found. Call plan_write first." }],
					details: {},
					isError: true,
				};
			}

			if (!state.gapReviewApproved) {
				return {
					content: [{ type: "text", text: "Error: Di Renjie has not cleared the latest saved draft. Run gap_review_complete with approved=true after reviewing the current saved draft." }],
					details: {},
					isError: true,
				};
			}

			const trimmed = typeof params.title === "string" ? params.title.trim().replace(/\.md$/i, "") : (state.planTitle ?? "");
			if (!trimmed || /[/\\]/.test(trimmed)) {
				return {
					content: [{ type: "text", text: "Error: Title must be non-empty without path separators. Pass title to exit_plan_mode or persist one earlier with plan_write(name=...)." }],
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
