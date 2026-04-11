import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { buildHighAccuracyRefinementMessage } from "./plan-context.js";
import type { ModeStateManager } from "./mode-state.js";
import { formatPlanDisplay, hydratePlanState, LOCAL_PLAN_URI, resolveExitPlanTitle, writeLocalPlanSnapshot } from "./plan-storage.js";
import { promptPostPlanAction } from "./plannotator.js";
import type { PlanEntry } from "./types.js";

export function registerPlanTools(pi: ExtensionAPI, state: ModeStateManager): void {
	pi.registerTool({
		name: "plan_write",
		label: "PlanWrite",
		description: `Compatibility save: persist plan markdown to ${LOCAL_PLAN_URI} and append a session snapshot for bounded legacy recovery. Normal Fu Xi workflow should write or edit ${LOCAL_PLAN_URI} directly.`,
		parameters: Type.Object({
			content: Type.String({ description: "Full plan content in markdown" }),
			name: Type.Optional(Type.String({ description: "Optional short plan name/title to persist with this compatibility save" })),
			isDraft: Type.Optional(Type.Boolean({ description: "Whether this save is a draft checkpoint. Defaults to true." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const isDraft = params.isDraft ?? true;
			const rawName = typeof params.name === "string" ? params.name.trim().replace(/\.md$/i, "") : "";
			if (rawName && /[/\\]/.test(rawName)) {
				return {
					content: [{ type: "text", text: "Error: Name must not contain path separators." }],
					details: {},
					isError: true,
				};
			}

			const snapshot = await writeLocalPlanSnapshot(ctx, params.content);
			state.planContent = snapshot.content;
			state.planTitle = rawName || snapshot.title;
			state.planTitleSource = rawName ? "compat-name" : snapshot.titleSource;
			state.resetPlanReviewState();
			state.persistState();
			pi.appendEntry<PlanEntry>("plan", {
				title: state.planTitle,
				content: params.content,
				draft: isDraft,
			});

			return {
				content: [{
					type: "text",
					text: isDraft
						? `Compatibility draft save${state.planTitle ? ` \"${state.planTitle}\"` : ""} written to ${LOCAL_PLAN_URI}; session history snapshot updated for legacy recovery. Re-run Di Renjie gap review on the latest local draft before exit_plan_mode.`
						: `Compatibility save${state.planTitle ? ` \"${state.planTitle}\"` : ""} written to ${LOCAL_PLAN_URI}; session history snapshot updated for legacy recovery. Call exit_plan_mode when you are ready for the post-plan action menu.`,
				}],
				details: { title: state.planTitle, draft: isDraft },
			};
		},
	});

	pi.registerTool({
		name: "gap_review_complete",
		label: "GapReviewComplete",
		description: `Record the result of the latest Di Renjie gap review for the current plan in ${LOCAL_PLAN_URI} (with bounded legacy recovery).`,
		parameters: Type.Object({
			approved: Type.Boolean({ description: "Whether Di Renjie cleared the latest saved draft for finalize" }),
			feedback: Type.Optional(Type.String({ description: "Di Renjie review feedback or watchouts" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const snapshot = await hydratePlanState(ctx, state);
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
		name: "exit_plan_mode",
		label: "ExitPlanMode",
		description:
			`Finalize the plan from ${LOCAL_PLAN_URI} and signal completion. Clear the latest local draft through gap_review_complete before exiting plan mode. Provide a short title here, or add a first-level markdown heading to ${LOCAL_PLAN_URI}.`,
		parameters: Type.Object({
			title: Type.Optional(Type.String({ description: `Optional short plan title. If omitted, the first markdown H1 in ${LOCAL_PLAN_URI} is used.` })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const snapshot = await hydratePlanState(ctx, state);
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
					content: [{ type: "text", text: `Error: Title is required. Pass title to exit_plan_mode or add a first markdown H1 to ${LOCAL_PLAN_URI}.` }],
					details: {},
					isError: true,
				};
			}

			state.planContent = snapshot.content;
			state.planTitle = resolvedTitle.title;
			state.planTitleSource = resolvedTitle.titleSource;
			state.planActionPending = true;
			pi.appendEntry<PlanEntry>("plan", { title: resolvedTitle.title, content: snapshot.content, draft: false });
			state.persistState();
			return {
				content: [{ type: "text", text: `Plan \"${resolvedTitle.title}\" saved. Choose what to do next.` }],
				details: { title: resolvedTitle.title, planActionPending: state.planActionPending, source: snapshot.source },
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
			const snapshot = await hydratePlanState(ctx, state);
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
				state.planActionPending = true;
				state.persistState();
				if (ctx.hasUI) {
					ctx.ui.notify(`Plan \"${state.planTitle}\" approved in high accuracy review.`, "info");
				}
				await promptPostPlanAction(pi, state, ctx);
				return {
					content: [{ type: "text", text: `High accuracy review approved for plan \"${state.planTitle}\".` }],
					details: { approved: true, source: snapshot.source },
				};
			}

			state.planActionPending = false;
			state.persistState();
			if (ctx.hasUI) {
				ctx.ui.notify(`Plan \"${state.planTitle}\" needs revision after high accuracy review.`, "warning");
			}
			if (state.currentMode === "fuxi") {
				pi.sendUserMessage(buildHighAccuracyRefinementMessage(state));
			}
			return {
				content: [{ type: "text", text: `High accuracy review feedback recorded for plan \"${state.planTitle}\".` }],
				details: { approved: false, source: snapshot.source },
			};
		},
	});

	pi.registerTool({
		name: "plan_read",
		label: "PlanRead",
		description:
			`Read the current plan from ${LOCAL_PLAN_URI}. Falls back to the latest saved plan entry for legacy recovery after compaction or manual Hou Tu entry.`,
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const snapshot = await hydratePlanState(ctx, state);
			if (snapshot) {
				return {
					content: [
						{
							type: "text",
							text: formatPlanDisplay(snapshot),
						},
					],
					details: { source: snapshot.source },
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
