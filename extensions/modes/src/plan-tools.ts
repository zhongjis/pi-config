import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { buildHighAccuracyRefinementMessage } from "./plan-context.js";
import { LOCAL_PLAN_URI } from "./plan-local.js";
import type { ModeStateManager } from "./mode-state.js";
import { hydratePlanState, resolveExitPlanTitle } from "./plan-storage.js";
import { prepareApprovedPlanHandoff, promptPostPlanAction } from "./plannotator.js";
import type { PlanEntry } from "./types.js";

function buildFinalizeStatusMessage(title: string, state: ModeStateManager): string {
	if (state.planReviewPending) {
		return `Plan \"${title}\" finalized. Sent to Plannotator for refinement review.`;
	}
	if (state.highAccuracyReviewPending) {
		return `Plan \"${title}\" finalized. High accuracy review queued.`;
	}
	if (state.planActionPending) {
		return `Plan \"${title}\" finalized. Approval menu opened.`;
	}
	return `Plan \"${title}\" finalized. Awaiting approval.`;
}


export function registerPlanTools(pi: ExtensionAPI, state: ModeStateManager): void {
	pi.registerTool({
		name: "gap_review_complete",
		label: "GapReviewComplete",
		description: `Record the result of the latest Di Renjie gap review for the current plan in ${LOCAL_PLAN_URI} (with bounded legacy recovery).`,
		parameters: Type.Object({
			approved: Type.Boolean({ description: "Whether Di Renjie cleared the latest saved draft for finalize" }),
			feedback: Type.Optional(Type.String({ description: "Di Renjie review feedback or watchouts" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const snapshot = await hydratePlanState(ctx as any, state);
			if (!snapshot) {
				return {
					content: [{ type: "text", text: `Error: No saved draft found in ${LOCAL_PLAN_URI}. Write or save the plan to ${LOCAL_PLAN_URI} first.` }],
					details: {},
					isError: true,
				};
			}

			state.gapReviewApproved = params.approved;
			state.gapReviewFeedback = params.feedback?.trim() || undefined;
			state.persistState();

			return {
				content: [{ type: "text", text: params.approved ? "Gap review cleared for the latest local draft." : "Gap review feedback recorded for the latest local draft." }],
				details: { approved: params.approved, source: snapshot.source },
			};
		},
	});

	pi.registerTool({
		name: "finalize_plan",
		label: "FinalizePlan",
		description:
			`Finalize the plan from ${LOCAL_PLAN_URI} and move plan mode into approval flow. Clear the latest local draft through gap_review_complete before finalizing. Provide a short title here, or add a first-level markdown heading to ${LOCAL_PLAN_URI}.`,
		parameters: Type.Object({
			title: Type.Optional(Type.String({ description: `Optional short plan title. If omitted, the first markdown H1 in ${LOCAL_PLAN_URI} is used.` })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const snapshot = await hydratePlanState(ctx as any, state);
			if (!snapshot) {
				return {
					content: [{ type: "text", text: `Error: No plan found in ${LOCAL_PLAN_URI}. Write or save the plan to ${LOCAL_PLAN_URI} first.` }],
					details: {},
					isError: true,
				};
			}

			if (!state.gapReviewApproved) {
				return {
					content: [{ type: "text", text: "Error: Di Renjie has not cleared the latest local draft. Run gap_review_complete with approved=true after reviewing the current plan." }],
					details: {},
					isError: true,
				};
			}

			const trimmed = typeof params.title === "string" ? params.title.trim().replace(/\.md$/i, "") : undefined;
			if (trimmed && /[/\\]/.test(trimmed)) {
				return {
					content: [{ type: "text", text: "Error: Title must not contain path separators." }],
					details: {},
					isError: true,
				};
			}

			const resolvedTitle = resolveExitPlanTitle(snapshot, trimmed);
			if (!resolvedTitle.title) {
				return {
					content: [{ type: "text", text: `Error: Title is required. Pass title to finalize_plan or add a first markdown H1 to ${LOCAL_PLAN_URI}.` }],
					details: {},
					isError: true,
				};
			}

			state.planContent = snapshot.content;
			state.planTitle = resolvedTitle.title;
			state.planTitleSource = resolvedTitle.titleSource;
			state.planActionPending = true;
			state.planApproved = false;
			state.planApprovalSource = undefined;
			pi.appendEntry<PlanEntry>("plan", { title: resolvedTitle.title, content: snapshot.content, draft: false });
			state.persistState();
			if (ctx.hasUI) {
				await promptPostPlanAction(pi, state, ctx);
			}
			const statusMessage = buildFinalizeStatusMessage(resolvedTitle.title, state);
			return {
				content: [{ type: "text", text: statusMessage }],
				details: { title: resolvedTitle.title, planActionPending: state.planActionPending, source: snapshot.source, mode: state.currentMode },
			};
		},
	});

	pi.registerTool({
		name: "exit_plan_mode",
		label: "ExitPlanMode",
		description: `Prepare Hou Tu handoff for the current approved finalized plan from ${LOCAL_PLAN_URI}. In interactive sessions this prefills /handoff:continue for manual submission.`,
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const snapshot = await hydratePlanState(ctx as any, state);
			if (!snapshot || !state.planTitle) {
				return {
					content: [{ type: "text", text: `Error: No finalized plan found in ${LOCAL_PLAN_URI}. Finalize the plan first.` }],
					details: {},
					isError: true,
				};
			}

			const isApproved = state.planApproved || state.planReviewApproved || state.highAccuracyReviewApproved;
			if (!isApproved) {
				return {
					content: [{ type: "text", text: "Error: Plan approval is required before handoff. Get direct approval, Plannotator approval, or high accuracy approval first." }],
					details: {},
					isError: true,
				};
			}

			const result = await prepareApprovedPlanHandoff(pi, state, ctx);
			return {
				content: [{ type: "text", text: result.message }],
				details: result.details,
				isError: !result.success,
			};
		},
	});

	pi.registerTool({
		name: "high_accuracy_review_complete",
		label: "HighAccuracyReviewComplete",
		description: `Record the result of an explicit Yanluo high accuracy review for the current saved plan from ${LOCAL_PLAN_URI}.`,
		parameters: Type.Object({
			approved: Type.Boolean({ description: "Whether Yanluo approved the current saved plan" }),
			feedback: Type.Optional(Type.String({ description: "Yanluo review feedback or notes" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const snapshot = await hydratePlanState(ctx as any, state);
			if (!snapshot || !state.planTitle) {
				return {
					content: [{ type: "text", text: `Error: No saved plan found in ${LOCAL_PLAN_URI}. Write or save the plan to ${LOCAL_PLAN_URI} first.` }],
					details: {},
					isError: true,
				};
			}

			state.highAccuracyReviewPending = false;
			state.highAccuracyReviewApproved = params.approved;
			state.highAccuracyReviewFeedback = params.feedback?.trim() || undefined;

			if (params.approved) {
				state.planApproved = true;
				state.planApprovalSource = "high-accuracy";
				state.planActionPending = true;
				state.persistState();
				const result = await prepareApprovedPlanHandoff(pi, state, ctx);
				return {
					content: [{ type: "text", text: result.message }],
					details: { approved: true, source: snapshot.source, ...(result.details ?? {}) },
					isError: !result.success,
				};
			}

			state.planApproved = false;
			state.planApprovalSource = undefined;
			state.planActionPending = false;
			state.persistState();
			if (ctx.hasUI) {
				ctx.ui.notify(`Plan \"${state.planTitle}\" needs revision after high accuracy review.`, "warning");
			}
			if (state.currentMode === "fuxi") {
				pi.sendUserMessage(buildHighAccuracyRefinementMessage(state), { deliverAs: "followUp" });
			}
			return {
				content: [{ type: "text", text: `High accuracy review feedback recorded for plan \"${state.planTitle}\".` }],
				details: { approved: false, source: snapshot.source },
			};
		},
	});
}
