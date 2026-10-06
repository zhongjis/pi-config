import { randomUUID } from "node:crypto";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { parseGoalCommand } from "./goal/command.js";
import { buildBudgetLimitedPrompt, buildContinuationPrompt } from "./goal/prompt.js";
import { createGoalAdmission } from "./goal/continuation.js";
import { formatGoalForTool, formatGoalToolResponse, goalStatusLabel } from "./goal/format.js";
import { renderGoalCall, renderGoalResult } from "./goal/render.js";
import { GoalAlreadyExistsError, GoalChangedError, GoalNotFoundError } from "./goal/errors.js";
import { accountGoalUsage, amendGoal, clearGoal, createGoal, readGoal, updateGoal } from "./goal/store.js";
import type { Goal, GoalAccountingMode, GoalStoreRef, TokenUsageSnapshot } from "./goal/types.js";
import { goalStoreRef } from "./goal/context.js";
import { COMPLETABLE_GOAL_STATUS_VALUES, isRecord } from "./goal/types.js";
import { updateGoalUi } from "./goal/ui.js";

import { GOAL_ACCESS_ENTRY, GOAL_TOOL_NAMES, goalToolAccess, modesOwnGoalTools } from "./goal/access.js";
import { GOAL_BOOTSTRAP_MESSAGE_TYPE, GOAL_BOOTSTRAP_PROMPT } from "./goal/bootstrap.js";

const GOAL_USAGE = "Usage: /goal <objective>";
const GOAL_EMPTY_HINT = "No goal is currently set.";
const GOAL_CONTINUATION_MESSAGE_TYPE = "pi-goal-continuation";
const GOAL_BUDGET_LIMIT_MESSAGE_TYPE = "pi-goal-budget-limit";
const REPLACE_GOAL_CHOICE = "Replace current goal";
const CANCEL_REPLACE_GOAL_CHOICE = "Cancel";
const EMPTY_USAGE: TokenUsageSnapshot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
const STALE_EXTENSION_CONTEXT_ERROR_PREFIX = "This extension ctx is stale after session replacement or reload.";

type GoalToolResult = AgentToolResult<Record<string, never>> & { isError?: boolean };
type AssistantUsageMessage = {
	role: "assistant";
	usage: Record<string, unknown>;
};
type AgentGoalAccounting = {
	goalId: string;
	measuredFromMilliseconds: number;
};

export default function (pi: ExtensionAPI): void {
	let activeCtx: ExtensionContext | undefined;
	let pendingBootstrap: string | undefined;
	let bootstrapId: string | undefined;
	const unsubscribeActivation = pi.events.on("ulw:activated", (event: unknown) => {
		if (!activeCtx || !isRecord(event) || typeof event.sessionId !== "string" || event.sessionId !== activeCtx.sessionManager.getSessionId()) return;
		pi.appendEntry(GOAL_ACCESS_ENTRY, { sessionId: event.sessionId });
		pendingBootstrap = event.sessionId;
	});

	async function refreshToolAccess(ctx: ExtensionContext): Promise<void> {
		if (modesOwnGoalTools(pi)) return;
		const allowed = await goalToolAccess(ctx);
		const registered = new Set(pi.getAllTools().map((tool) => tool.name));
		pi.setActiveTools([
			...pi.getActiveTools().filter((name) => !GOAL_TOOL_NAMES.some((goalName) => goalName === name)),
			...allowed.filter((name) => registered.has(name)),
		]);
	}

	pi.on("before_agent_start", async (_event, ctx) => {
		const pending = pendingBootstrap;
		pendingBootstrap = undefined;
		bootstrapId = undefined;
		await refreshToolAccess(ctx);
		if (pending !== undefined && pending === ctx.sessionManager.getSessionId()) {
			bootstrapId = randomUUID();
			return { message: { customType: GOAL_BOOTSTRAP_MESSAGE_TYPE, content: GOAL_BOOTSTRAP_PROMPT, display: false, details: { bootstrapId } } };
		}
	});
	pi.on("session_before_switch", () => {
		admission.invalidate();
		resumedInput = undefined;
		pendingBootstrap = undefined;
		bootstrapId = undefined;
	});

	let agentTurnInProgress = false;
	let agentGoalAccounting: AgentGoalAccounting | null = null;
	let completedThisTurnGoalId: string | null = null;
	const admission = createGoalAdmission();
	let run: {
		ref: GoalStoreRef;
		goalId: string;
		generation: number;
		amendmentVersion: number;
		signal?: AbortSignal;
		aborted: boolean;
	} | null = null;
	let removeAbortListener: (() => void) | undefined;

	let confirmingOffer: string | undefined;
	let resumedInput: { ref: GoalStoreRef; goalId: string; generation: number } | undefined;

	pi.on("input", async (event, ctx) => {
		if ((event.source !== "interactive" && event.source !== "rpc") || event.text.trimStart().startsWith("/")) return;
		const ref = goalStoreRef(ctx);
		const generation = admission.generation;
		const isCurrent = () => {
			if (generation !== admission.generation) return false;
			const live = goalStoreRef(ctx);
			return live.baseDir === ref.baseDir && live.threadId === ref.threadId;
		};
		const goal = await readGoal(ref);
		if (!goal || !isCurrent()) return;
		const steer = goal.status === "active" && event.streamingBehavior === "steer";
		const offer =
			goal.status === "paused" && event.streamingBehavior === undefined ? goal.cancellationOffer : undefined;
		if (!steer && (!offer || confirmingOffer === offer)) return;
		let decision = "steer-accepted";
		let accepted = steer;
		try {
			if (!steer) {
				confirmingOffer = offer;
				const hasUI = ctx.hasUI;
				const choice = hasUI
					? await ctx.ui.select(
							`Continue existing goal?\nOriginal objective: ${goal.objective}\nContinue adds this message as an amendment and resumes the same Goal.`,
							["Keep paused", "Continue existing goal"],
						)
					: undefined;
				accepted = choice === "Continue existing goal";
				decision = accepted ? "continue" : !hasUI ? "no-ui" : choice === "Keep paused" ? "keep-paused" : "dismissed";
			}
			const next = await amendGoal(ref, accepted ? event.text : undefined, {
				expectedGoalId: goal.id,
				cancellationOffer: steer ? undefined : offer,
				isCurrent,
			});
			pi.appendEntry("pi-goal-input-decision", {
				goalId: next.id,
				decision,
				source: event.source,
				amendmentVersion: next.amendments?.length ?? 0,
			});
			if (accepted && !steer && isCurrent()) resumedInput = { ref, goalId: next.id, generation };
			updateGoalUiBestEffort(ctx, next);
		} catch (error) {
			if (!(error instanceof GoalChangedError)) throw error;
			const liveRef = activeCtx ? goalStoreRef(activeCtx) : undefined;
			if (liveRef?.baseDir === ref.baseDir && liveRef.threadId === ref.threadId)
				pi.appendEntry("pi-goal-input-decision", {
					goalId: goal.id,
					decision: "stale",
					source: event.source,
					amendmentVersion: goal.amendments?.length ?? 0,
				});
		} finally {
			if (confirmingOffer === offer) confirmingOffer = undefined;
		}
		// Native input, attachments, expansion and scheduling remain untouched.
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const pending = resumedInput;
		resumedInput = undefined;
		if (!pending || pending.generation !== admission.generation) return;
		const ref = goalStoreRef(ctx);
		if (ref.baseDir !== pending.ref.baseDir || ref.threadId !== pending.ref.threadId) return;
		const goal = await readGoal(ref);
		if (
			!goal ||
			goal.id !== pending.goalId ||
			pending.generation !== admission.generation ||
			(goal.status !== "active" && goal.status !== "budgetLimited")
		)
			return;
		admission.committed(goal);
		return {
			message: {
				customType: goal.status === "active" ? GOAL_CONTINUATION_MESSAGE_TYPE : GOAL_BUDGET_LIMIT_MESSAGE_TYPE,
				content: goal.status === "active" ? buildContinuationPrompt(goal) : buildBudgetLimitedPrompt(goal),
				display: false,
				details: { goalId: goal.id, amendmentVersion: goal.amendments?.length ?? 0 },
			},
		};
	});

	async function queueGoalContinuation(ctx: ExtensionContext, goal: Goal): Promise<void> {
		const generation = admission.generation;
		const draft = await admission.admit(ctx, goal);
		if (draft && generation === admission.generation) {
			admission.committed(goal);
			pi.sendMessage(draft, { triggerTurn: true, deliverAs: "followUp" });
		}
	}

	pi.registerTool({
		name: "create_goal",
		exposure: "deferred",
		label: "Create Goal",
		description:
			"Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.\nSet token_budget only when an explicit token budget is requested. Fails if an unfinished goal exists; use update_goal only for status.",
		parameters: Type.Object(
			{
				objective: Type.String({
					description:
						"Required. The concrete objective to start pursuing. This starts a new active goal when no goal exists or replaces the current goal when it is complete.",
				}),
				token_budget: Type.Optional(
					Type.Integer({ description: "Positive token budget for the new goal. Omit unless explicitly requested." }),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const ref = goalStoreRef(ctx);
			let goal: Goal;
			const generation = admission.generation;
			try {
				goal = await createGoal(
					ref,
					params.objective,
					params.token_budget,
					() => generation === admission.generation && !ctx.signal?.aborted,
				);
			} catch (error) {
				if (error instanceof GoalAlreadyExistsError) return toolText(error.message, true);
				throw error;
			}
			if (generation !== admission.generation) return toolText("goal control changed", true);
			beginAgentGoalAccounting(goal);
			if (agentTurnInProgress)
				run = {
					ref,
					goalId: goal.id,
					amendmentVersion: goal.amendments?.length ?? 0,
					generation: admission.generation,
					signal: ctx.signal,
					aborted: ctx.signal?.aborted ?? false,
				};
			updateGoalUi(ctx, goal);
			return toolText(formatGoalToolResponse(goal, false));
		},
		renderCall(args, theme) {
			return renderGoalCall("create_goal", args, theme);
		},
		renderResult(result, options, theme, context) {
			return renderGoalResult(result, options, theme, context);
		},
	});

	pi.registerTool({
		name: "update_goal",
		exposure: "deferred",
		label: "Update Goal",
		description:
			"Update the existing goal.\nUse this tool only to mark the goal achieved or genuinely blocked.\nSet status to `complete` only when the objective has actually been achieved and no required work remains.\nSet status to `blocked` only when the same blocking condition has repeated for at least three consecutive goal turns, counting the original/user-triggered turn and any automatic continuations, and available authorized paths are exhausted: progress requires unavailable external state or a necessary unanswered user decision. Three turns are a floor, not an attempt cap. Do not block while a live background result, pending question, or available path can resolve the impasse. Supply a specific nonempty blockedReason.\nIf the user resumes a goal that was previously marked `blocked`, treat the resumed run as a fresh blocked audit. If the same blocking condition then repeats for at least three consecutive resumed goal turns, set status to `blocked` again.\nOnce the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; set status to `blocked`.\nDo not use `blocked` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.\nDo not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.\nYou cannot use this tool to pause, resume, budget-limit, or usage-limit a goal; those status changes are controlled by the user or system.\nWhen marking a budgeted goal achieved with status `complete`, report the final token usage from the tool result to the user.",
		parameters: Type.Object(
			{
				blockedReason: Type.Optional(Type.String({ description: "Specific exhausted impasse; required for blocked." })),
				status: Type.Union(
					COMPLETABLE_GOAL_STATUS_VALUES.map((status) => Type.Literal(status)),
					{
						description:
							"Required. Set to `complete` only when the objective is achieved and no required work remains. Set to `blocked` only after the same blocking condition has recurred for at least three consecutive goal turns and the agent is at an impasse. After a previously blocked goal is resumed, the resumed run starts a fresh blocked audit.",
					},
				),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.status !== "complete" && params.status !== "blocked") {
				return toolText(
					"update_goal can only mark the existing goal complete or blocked; pause, resume, budget-limited, and usage-limited status changes are controlled by the user or system",
					true,
				);
			}
			const ref = goalStoreRef(ctx);
			const generation = admission.generation;
			const amendmentVersion = run?.amendmentVersion;
			const current = await readGoal(ref);
			if (
				!current ||
				(amendmentVersion !== undefined && amendmentVersion !== (current.amendments?.length ?? 0)) ||
				generation !== admission.generation ||
				(run && (run.goalId !== current.id || run.generation !== generation))
			) {
				return toolText("goal changed before update; read the current goal again", true);
			}
			await accountCurrentAgentTurn(ctx, EMPTY_USAGE, "active");
			if (generation !== admission.generation || ctx.signal?.aborted) return toolText("goal control changed", true);
			const goal = await updateGoal(
				ref,
				{ status: params.status, blockedReason: params.blockedReason },
				{
					expectedGoalId: current.id,
					expectedStatus: current.status,
					expectedAmendmentVersion: amendmentVersion ?? (current.amendments?.length ?? 0),
					actor: "model",
					isCurrent: () => generation === admission.generation && !ctx.signal?.aborted,
				},
			);
			if (generation !== admission.generation) return toolText("goal control changed", true);
			if (params.status === "complete") {
				markGoalCompletedThisTurn(goal);
			} else {
				stopAgentGoalAccounting(goal.id);
			}
			updateGoalUi(ctx, goal);
			return toolText(formatGoalToolResponse(goal, params.status === "complete"));
		},
		renderCall(args, theme) {
			return renderGoalCall("update_goal", args, theme);
		},
		renderResult(result, options, theme, context) {
			return renderGoalResult(result, options, theme, context);
		},
	});

	pi.registerTool({
		name: "get_goal",
		exposure: "deferred",
		label: "Get Goal",
		description:
			"Get the current goal for this thread, including status, budgets, token and elapsed-time usage, and remaining token budget.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const goal = await readGoal(goalStoreRef(ctx));
			updateGoalUi(ctx, goal);
			return toolText(formatGoalToolResponse(goal, false));
		},
		renderCall(args, theme) {
			return renderGoalCall("get_goal", args, theme);
		},
		renderResult(result, options, theme, context) {
			return renderGoalResult(result, options, theme, context);
		},
	});

	pi.registerCommand("goal", {
		description: "Set, inspect, pause, resume, or clear the persistent goal",
		handler: async (rawArgs, ctx) => {
			pi.appendEntry(GOAL_ACCESS_ENTRY, { sessionId: ctx.sessionManager.getSessionId() });
			await refreshToolAccess(ctx);
			const command = parseGoalCommand(rawArgs);
			if (command.kind !== "show") admission.invalidate();
			const generation = admission.generation;
			const ref = goalStoreRef(ctx);
			try {
				switch (command.kind) {
					case "show": {
						const goal = await readGoal(goalStoreRef(ctx));
						updateGoalUi(ctx, goal);
						ctx.ui.notify(
							goal === null ? `${GOAL_USAGE}\n${GOAL_EMPTY_HINT}` : formatGoalForTool(goal),
							goal ? "info" : "warning",
						);
						return;
					}
					case "setObjective": {
						await setGoalObjective(ctx, command.objective);
						return;
					}
					case "setStatus": {
						const current = await readGoal(ref);
						if (generation !== admission.generation) return;
						if (!current) throw new GoalNotFoundError("cannot update goal: no goal exists");
						if (command.status === "paused") {
							await accountCurrentAgentTurn(ctx, EMPTY_USAGE, "active");
						}
						const goal = await updateGoal(
							ref,
							{ status: command.status },
							{
								expectedGoalId: current.id,
								actor: "user",
								isCurrent: () => generation === admission.generation,
							},
						);
						if (goal.status === "active") {
							beginAgentGoalAccounting(goal);
						} else if (!agentTurnInProgress) {
							stopAgentGoalAccounting(goal.id);
						}
						updateGoalUi(ctx, goal);
						ctx.ui.notify(`Goal ${goalStatusLabel(goal.status)}\n${formatGoalForTool(goal)}`, "info");
						await queueGoalContinuation(ctx, goal);
						return;
					}
					case "clear": {
						await accountCurrentAgentTurn(ctx, EMPTY_USAGE, "active");
						const cleared = await clearGoal(ref, () => generation === admission.generation);
						clearAgentGoalAccounting();
						updateGoalUi(ctx, null);
						ctx.ui.notify(
							cleared ? "Goal cleared" : "No goal to clear\nThis thread does not currently have a goal.",
							cleared ? "info" : "warning",
						);
						return;
					}
				}
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		pendingBootstrap = undefined;
		bootstrapId = undefined;
		await refreshToolAccess(ctx);
		admission.invalidate();
		removeAbortListener?.();
		run = null;
		clearAgentGoalAccounting();
		const generation = admission.generation;
		const goal = await readGoal(goalStoreRef(ctx));
		if (generation !== admission.generation) return;
		if (goal?.status === "active") beginAgentGoalAccounting(goal);
		updateGoalUi(ctx, goal);
		if (goal) await queueGoalContinuation(ctx, goal);
	});

	pi.on("agent_start", async (_event, ctx) => {
		admission.started();
		agentTurnInProgress = true;
		completedThisTurnGoalId = null;
		removeAbortListener?.();
		const ref = goalStoreRef(ctx);
		const generation = admission.generation;
		const signal = ctx.signal;
		const goal = await readGoal(ref);
		if (generation !== admission.generation) return;
		run =
			goal && (goal.status === "active" || goal.status === "budgetLimited")
				? { ref, goalId: goal.id, generation, amendmentVersion: goal.amendments?.length ?? 0, signal, aborted: signal?.aborted ?? false }
				: null;
		const currentRun = run;
		const onAbort = () => {
			if (currentRun) currentRun.aborted = true;
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		removeAbortListener = () => signal?.removeEventListener("abort", onAbort);
		if (goal?.status === "active") beginAgentGoalAccounting(goal);
		else agentGoalAccounting = null;
	});

	async function pauseAbortedRun(ctx: ExtensionContext): Promise<void> {
		const currentRun = run;
		if (!currentRun?.aborted || currentRun.generation !== admission.generation) return;
		const goal = await readGoal(currentRun.ref);
		if (
			currentRun.generation !== admission.generation ||
			goal?.id !== currentRun.goalId ||
			(goal.status !== "active" && goal.status !== "budgetLimited")
		)
			return;
		let paused: Goal;
		try {
			paused = await updateGoal(
				currentRun.ref,
				{ status: "paused" },
				{
					expectedGoalId: currentRun.goalId,
					expectedStatus: goal.status,
					actor: "abort",
					isCurrent: () => currentRun.generation === admission.generation,
				},
			);
		} catch (error) {
			if (error instanceof GoalChangedError || error instanceof GoalNotFoundError) return;
			throw error;
		}
		admission.invalidate();
		updateGoalUiBestEffort(ctx, paused);
	}

	pi.on("turn_end", async (event, ctx) => {
		if (event.outcome === "aborted" && run) run.aborted = true;
		await pauseAbortedRun(ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		bootstrapId = undefined;
		if (
			run &&
			(run.signal?.aborted ||
				event.messages.some((message) => message.role === "assistant" && message.stopReason === "aborted"))
		)
			run.aborted = true;
		await pauseAbortedRun(ctx);
		const mode: GoalAccountingMode = completedThisTurnGoalId === null ? "activeOrStopped" : "activeOrComplete";
		const goal = await accountCurrentAgentTurn(ctx, collectAssistantUsage(event.messages), mode);
		agentTurnInProgress = false;
		completedThisTurnGoalId = null;
		if (goal?.status !== "active") clearAgentGoalAccounting();
		updateGoalUiBestEffort(ctx, goal);
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "completed" || event.continue || run?.aborted) return;
		const generation = admission.generation;
		const ref = goalStoreRef(ctx);
		const goal = await readGoal(ref);
		if (!goal || generation !== admission.generation) return;
		const draft = await admission.admit(ctx, goal, true);
		if (!draft || generation !== admission.generation) return;
		admission.committed(goal);
		return { entries: [draft], continue: true };
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (run?.signal?.aborted) run.aborted = true;
		await pauseAbortedRun(ctx);
		removeAbortListener?.();
		run = null;
	});

	pi.on("context", async (event, ctx) => {
		const goal = await readGoal(goalStoreRef(ctx));
		const messages = event.messages.filter((message) => {
			if (message.role === "custom" && message.customType === GOAL_BOOTSTRAP_MESSAGE_TYPE) {
				return bootstrapId !== undefined && isRecord(message.details) && message.details.bootstrapId === bootstrapId;
			}
			if (
				message.role !== "custom" ||
				(message.customType !== GOAL_CONTINUATION_MESSAGE_TYPE && message.customType !== GOAL_BUDGET_LIMIT_MESSAGE_TYPE)
			)
				return true;
			return (
				isRecord(message.details) &&
				message.details.goalId === goal?.id &&
				(message.details.amendmentVersion ?? 0) === (goal?.amendments?.length ?? 0) &&
				(goal?.status === "active"
					? message.customType === GOAL_CONTINUATION_MESSAGE_TYPE
					: goal?.status === "budgetLimited" && message.customType === GOAL_BUDGET_LIMIT_MESSAGE_TYPE)
			);
		});
		if (
			goal?.status === "active" &&
			!messages.some((message) => message.role === "custom" && message.customType === GOAL_CONTINUATION_MESSAGE_TYPE)
		) {
			for (const message of event.messages) {
				if (
					message.role !== "custom" ||
					message.customType !== GOAL_CONTINUATION_MESSAGE_TYPE ||
					!isRecord(message.details) ||
					message.details.goalId !== goal.id
				)
					continue;
				const version = message.details.amendmentVersion ?? 0;
				if (typeof version !== "number" || version >= (goal.amendments?.length ?? 0)) continue;
				messages.push({
					...message,
					content: buildContinuationPrompt(goal),
					details: { goalId: goal.id, amendmentVersion: goal.amendments?.length ?? 0 },
				});
				break;
			}
		}
		if (goal && run?.goalId === goal.id && run.generation === admission.generation) {
			const amendmentVersion = goal.amendments?.length ?? 0;
			// A model-created Goal may have no earlier hidden continuation to refresh.
			if (
				goal.status === "active" &&
				amendmentVersion > 0 &&
				!messages.some((message) => message.role === "custom" && message.customType === GOAL_CONTINUATION_MESSAGE_TYPE)
			) {
				messages.push({
					role: "custom",
					customType: GOAL_CONTINUATION_MESSAGE_TYPE,
					content: buildContinuationPrompt(goal),
					display: false,
					timestamp: Date.now(),
					details: { goalId: goal.id, amendmentVersion },
				});
			}
			run.amendmentVersion = amendmentVersion;
		}
		return { messages };
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		unsubscribeActivation();
		activeCtx = undefined;
		pendingBootstrap = undefined;
		bootstrapId = undefined;
		admission.invalidate();
		removeAbortListener?.();
		if (agentGoalAccounting !== null) await accountCurrentAgentTurn(ctx, EMPTY_USAGE, "active");
		clearAgentGoalAccounting();
		run = null;
	});

	async function setGoalObjective(ctx: ExtensionContext, objective: string): Promise<void> {
		const ref = goalStoreRef(ctx);
		const generation = admission.generation;
		const current = await readGoal(ref);
		if (generation !== admission.generation) return;
		if (current !== null) {
			const shouldReplace = await confirmReplaceGoal(ctx, objective);
			if (!shouldReplace) return;
		}

		if (current?.status === "active") {
			await accountCurrentAgentTurn(ctx, EMPTY_USAGE, "active");
		}
		const goal =
			current === null
				? await createGoal(ref, objective, undefined, () => generation === admission.generation)
				: await updateGoal(
						ref,
						{ objective },
						{
							expectedGoalId: current.id,
							actor: "user",
							isCurrent: () => generation === admission.generation,
						},
					);
		if (goal.status === "active") beginAgentGoalAccounting(goal);
		updateGoalUi(ctx, goal);
		ctx.ui.notify(
			current === null || goal.id !== current.id
				? `Goal started\nObjective: ${goal.objective}`
				: `Goal ${goalStatusLabel(goal.status)}\n${formatGoalForTool(goal)}`,
			"info",
		);
		await queueGoalContinuation(ctx, goal);
	}

	async function confirmReplaceGoal(ctx: ExtensionContext, objective: string): Promise<boolean> {
		if (!ctx.hasUI) return true;
		const choice = await ctx.ui.select(`Replace goal?\nNew objective: ${objective}`, [
			REPLACE_GOAL_CHOICE,
			CANCEL_REPLACE_GOAL_CHOICE,
		]);
		return choice === REPLACE_GOAL_CHOICE;
	}

	function beginAgentGoalAccounting(goal: Goal): void {
		if (goal.status !== "active" || (agentTurnInProgress && run && run.goalId !== goal.id)) return;
		if (agentGoalAccounting?.goalId === goal.id) return;
		agentGoalAccounting = { goalId: goal.id, measuredFromMilliseconds: Date.now() };
	}

	function markGoalCompletedThisTurn(goal: Goal): void {
		if (!agentTurnInProgress) return;
		completedThisTurnGoalId = goal.id;
		agentGoalAccounting = { goalId: goal.id, measuredFromMilliseconds: Date.now() };
	}

	function stopAgentGoalAccounting(goalId: string): void {
		if (agentGoalAccounting?.goalId === goalId) {
			agentGoalAccounting = null;
		}
		if (completedThisTurnGoalId === goalId) {
			completedThisTurnGoalId = null;
		}
	}

	function clearAgentGoalAccounting(): void {
		agentGoalAccounting = null;
		completedThisTurnGoalId = null;
	}

	async function accountCurrentAgentTurn(
		ctx: ExtensionContext,
		usage: TokenUsageSnapshot,
		mode: GoalAccountingMode,
	): Promise<Goal | null> {
		const accounting = agentGoalAccounting;
		const ref = run?.ref ?? goalStoreRef(ctx);
		if (accounting === null) return readGoal(ref);

		const now = Date.now();
		const elapsedSeconds = Math.max(0, Math.round((now - accounting.measuredFromMilliseconds) / 1000));
		accounting.measuredFromMilliseconds = now;
		const goal = await accountGoalUsage(ref, usage, elapsedSeconds, mode, accounting.goalId);
		if (agentGoalAccounting === accounting && goal?.id !== accounting.goalId) clearAgentGoalAccounting();
		return goal;
	}
}

function updateGoalUiBestEffort(ctx: ExtensionContext, goal: Goal | null): void {
	try {
		updateGoalUi(ctx, goal);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith(STALE_EXTENSION_CONTEXT_ERROR_PREFIX)) {
			return;
		}
		throw error;
	}
}

function toolText(text: string, isError = false): GoalToolResult {
	return { content: [{ type: "text" as const, text }], details: {}, isError };
}

function collectAssistantUsage(messages: unknown[]): TokenUsageSnapshot {
	const usage: TokenUsageSnapshot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
	for (const message of messages) {
		if (!isAssistantUsageMessage(message)) continue;
		usage.input += numericUsageField(message.usage, "input");
		usage.output += numericUsageField(message.usage, "output");
		usage.cacheRead += numericUsageField(message.usage, "cacheRead");
		usage.cacheWrite += numericUsageField(message.usage, "cacheWrite");
		usage.totalTokens += numericUsageField(message.usage, "totalTokens");
	}
	return usage;
}

function isAssistantUsageMessage(message: unknown): message is AssistantUsageMessage {
	if (!isRecord(message)) return false;
	return message["role"] === "assistant" && isRecord(message["usage"]);
}

function numericUsageField(usage: Record<string, unknown>, key: string): number {
	const value = usage[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
