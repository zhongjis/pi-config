import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { buildHighAccuracyRefinementMessage } from "./plan-context.js";
import { getLocalPlanPath, LOCAL_PLAN_URI, readLocalPlanFile } from "./plan-local.js";
import type { ModeStateManager } from "./mode-state.js";
import { formatPlanDisplay, hydratePlanState, resolveExitPlanTitle, writeLocalPlanSnapshot } from "./plan-storage.js";
import { promptPostPlanAction } from "./plannotator.js";
import type { PlanEntry } from "./types.js";

const DEFAULT_READ_LIMIT = 2000;

function splitDisplayLines(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function getLineAnchor(lineNumber: number, line: string): string {
	let hash = 0;
	const input = `${lineNumber}:${line}`;
	for (let index = 0; index < input.length; index += 1) {
		hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
	}
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
	const first = alphabet[hash % alphabet.length] ?? "X";
	const second = alphabet[Math.floor(hash / alphabet.length) % alphabet.length] ?? "X";
	return `${first}${second}`;
}

function formatAnchoredRead(content: string, fileName: string, offset = 1, limit = DEFAULT_READ_LIMIT): string {
	const lines = splitDisplayLines(content);
	if (lines.length === 0) return `File is empty: ${fileName}`;
	if (offset > lines.length) return `Start line ${offset} exceeds file length ${lines.length} for ${fileName}.`;

	const startIndex = Math.max(0, offset - 1);
	return lines
		.slice(startIndex, startIndex + limit)
		.map((line, index) => {
			const lineNumber = startIndex + index + 1;
			return `${lineNumber}#${getLineAnchor(lineNumber, line)}:${line}`;
		})
		.join("\n");
}

function normalizePositiveInteger(value: unknown, fallbackValue: number, fieldName: string): number {
	if (value === undefined) return fallbackValue;
	if (!Number.isInteger(value) || (value as number) < 1) {
		throw new Error(`${fieldName} must be a positive integer.`);
	}
	return value as number;
}

function getErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const maybeCode = (error as { code?: unknown }).code;
	return typeof maybeCode === "string" ? maybeCode : undefined;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function registerPlanTools(pi: ExtensionAPI, state: ModeStateManager): void {
	pi.registerTool({
		name: "read_plan",
		label: "ReadPlan",
		description: `Compatibility read: inspect the current saved plan from ${LOCAL_PLAN_URI}. Prefer built-in read on ${LOCAL_PLAN_URI} in new sessions.`,
		parameters: Type.Object({
			offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed line number to start reading from." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, description: `Maximum number of lines to return. Defaults to ${DEFAULT_READ_LIMIT}.` })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const planPath = getLocalPlanPath(ctx);
			try {
				const offset = normalizePositiveInteger(params.offset, 1, "offset");
				const limit = normalizePositiveInteger(params.limit, DEFAULT_READ_LIMIT, "limit");
				const content = await readLocalPlanFile(ctx);
				return {
					content: [{ type: "text", text: formatAnchoredRead(content, "PLAN.md", offset, limit) }],
					details: {
						localPath: LOCAL_PLAN_URI,
						path: planPath,
						resolvedPath: planPath,
						backingPath: planPath,
						offset,
						limit,
						compatibilityAlias: "read_plan",
					},
				};
			} catch (error) {
				if (getErrorCode(error) === "ENOENT") {
					return {
						content: [{ type: "text", text: "Error: PLAN.md does not exist for this session yet." }],
						details: {
							localPath: LOCAL_PLAN_URI,
							path: planPath,
							resolvedPath: planPath,
							backingPath: planPath,
							compatibilityAlias: "read_plan",
						},
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: `Error reading PLAN.md: ${getErrorMessage(error)}` }],
					details: {
						localPath: LOCAL_PLAN_URI,
						path: planPath,
						resolvedPath: planPath,
						backingPath: planPath,
						compatibilityAlias: "read_plan",
					},
					isError: true,
				};
			}
		},
	});
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
