/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, only read-only tools are available.
 *
 * Features:
 * - /plan toggles read-only mode; /plan {request} runs the Prometheus planner
 * - Bash restricted to allowlisted read-only commands
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to complete steps during execution
 * - Progress tracking widget during execution
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent, ThinkingContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { Key } from "@mariozechner/pi-tui";
import { discoverAgents } from "../subagent/agents.js";
import { getResultSummaryText } from "../subagent/runner-events.js";
import { runAgent } from "../subagent/runner.js";
import {
	getVisibleDisplayItems,
	getVisibleMessages,
	getVisibleOutput,
	isResultError,
	type DisplayItem,
	type SingleResult,
	type SubagentDetails,
	type UsageStats,
} from "../subagent/types.js";
import { extractTodoItems, markCompletedSteps, type TodoItem } from "./utils.js";

const PLANNER_AGENT_NAME = "prometheus";
const PLANNER_DELEGATION_MODE = "spawn";
const PLANNER_RECENT_TOOL_LIMIT = 3;
const PLANNER_OUTPUT_MAX_LINES = 12;
const PLANNER_OUTPUT_MAX_CHARS = 1400;
const PLANNER_THINKING_MAX_LINES = 3;
const PLANNER_THINKING_MAX_CHARS = 200;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PLANNER_SPINNER_INTERVAL_MS = 250;
const EXECUTION_HEARTBEAT_INTERVAL_MS = 1000;
const HIDDEN_PLAN_MESSAGE_TYPES = new Set([
	"plan-mode-context",
	"plan-planner-status",
	"plan-planner-progress",
	"plan-planner-output",
	"plan-planner-error",
	"plan-extraction-warning",
	"plan-todo-list",
	"plan-complete",
	"plan-execution-context",
]);

type PlannerDecision = "plan" | "needs_more_detail" | "unknown";

interface PlanModeStateData {
	enabled: boolean;
	todos?: TodoItem[];
	executing?: boolean;
	lastPlanRequest?: string;
	lastPlanText?: string;
	plannerAgent?: string;
	planFilePath?: string;
	planTitle?: string;
}

type SharedAgentMode = "code" | "plan" | "architect" | "debug" | "ask" | "review" | "off";

interface SharedAgentModesApi {
	getMode(): SharedAgentMode;
	setMode(mode: SharedAgentMode, options?: { notify?: boolean }): Promise<boolean>;
}

type SharedAgentModesGlobalScope = typeof globalThis & {
	__piAgentModesApi?: SharedAgentModesApi;
};

function getSharedAgentModesApi(): SharedAgentModesApi | undefined {
	return (globalThis as SharedAgentModesGlobalScope).__piAgentModesApi;
}

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function getUserText(message: AgentMessage): string {
	if (!("content" in message)) {
		return "";
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	if (!Array.isArray(message.content)) {
		return "";
	}
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function createSubagentDetails(results: SingleResult[], projectAgentsDir: string | null): SubagentDetails {
	return {
		mode: "single",
		delegationMode: PLANNER_DELEGATION_MODE,
		projectAgentsDir,
		results,
	};
}

function shortenRequest(request: string, maxLength = 72): string {
	const trimmed = request.trim();
	if (trimmed.length <= maxLength) return trimmed;
	return `${trimmed.slice(0, maxLength - 3)}...`;
}

function getPlannerDecision(text: string): PlannerDecision {
	if (/^Decision:\s*NEEDS_MORE_DETAIL\s*$/im.test(text) || /^Need more detail:/im.test(text)) {
		return "needs_more_detail";
	}
	if (/^Decision:\s*PLAN\s*$/im.test(text) || /(?:^|\n)Plan:\s*\n/i.test(text)) {
		return "plan";
	}
	return "unknown";
}

function extractNeedMoreDetailQuestions(text: string): string[] {
	const headerMatch = text.match(/^Need more detail:\s*$/im);
	if (!headerMatch || headerMatch.index === undefined) return [];

	const section = text.slice(headerMatch.index + headerMatch[0].length);
	const questions: string[] = [];
	let sawBullet = false;
	for (const line of section.split("\n")) {
		const bulletMatch = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/);
		if (bulletMatch) {
			sawBullet = true;
			questions.push(bulletMatch[1].trim());
			continue;
		}
		if (sawBullet && line.trim().length > 0) break;
	}
	return questions;
}

function getStringArg(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	return typeof value === "string" ? value.trim() : "";
}

function summarizeToolCall(item: DisplayItem): string | null {
	if (item.type !== "toolCall") return null;

	const args = item.args;
	switch (item.name) {
		case "read": {
			const path = getStringArg(args, "path");
			return path ? `read ${path}` : "read";
		}
		case "grep": {
			const pattern = getStringArg(args, "pattern");
			return pattern ? `grep ${pattern}` : "grep";
		}
		case "find": {
			const pattern = getStringArg(args, "pattern");
			return pattern ? `find ${pattern}` : "find";
		}
		case "ls": {
			const path = getStringArg(args, "path");
			return path ? `ls ${path}` : "ls";
		}
		case "ask":
			return "ask for clarification";
		case "exit_plan_mode": {
			const title = getStringArg(args, "title");
			return title ? `exit_plan_mode: ${title}` : "exit_plan_mode";
		}
		case "subagent": {
			const agent = getStringArg(args, "agent");
			const task = getStringArg(args, "task");
			if (agent) {
				return task ? `subagent ${agent}: ${shortenRequest(task, 56)}` : `subagent ${agent}`;
			}

			const tasks = args["tasks"];
			if (Array.isArray(tasks)) {
				const agentNames = tasks
					.map((taskItem) => {
						if (!taskItem || typeof taskItem !== "object") return null;
						const nestedAgent = (taskItem as Record<string, unknown>)["agent"];
						return typeof nestedAgent === "string" ? nestedAgent.trim() : null;
					})
					.filter((name): name is string => Boolean(name));
				if (agentNames.length > 0) {
					return `subagent parallel: ${agentNames.join(", ")}`;
				}
			}

			return "subagent";
		}
		default:
			return item.name;
	}
}

function buildPlannerOutputPreview(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "";

	const lines = trimmed.split("\n").map((line) => line.trimEnd());
	const previewLines = lines.slice(-PLANNER_OUTPUT_MAX_LINES);
	const previewBody = previewLines.join("\n");
	const hiddenLineCount = lines.length - previewLines.length;
	const prefix =
		hiddenLineCount > 0
			? `⋯ ${hiddenLineCount} more line${hiddenLineCount === 1 ? "" : "s"}\n`
			: "";
	let preview = `${prefix}${previewBody}`;
	if (preview.length > PLANNER_OUTPUT_MAX_CHARS) {
		const available = PLANNER_OUTPUT_MAX_CHARS - prefix.length - 3;
		if (available <= 0) return prefix.trimEnd();
		preview = `${prefix}...${previewBody.slice(-available)}`;
	}
	return preview;
}

function formatPlannerTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatPlannerUsage(usage: UsageStats, model: string): string {
	const parts: string[] = [];
	if (usage.input) parts.push(`↑${formatPlannerTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatPlannerTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatPlannerTokens(usage.cacheRead)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function phaseToLabel(phase: string): string {
	if (phase === "starting") return "Analyzing";
	return phase.charAt(0).toUpperCase() + phase.slice(1);
}

function getThinkingPreview(result: SingleResult): string {
	const messages = getVisibleMessages(result);
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (let j = msg.content.length - 1; j >= 0; j--) {
			const block = msg.content[j];
			if (block.type === "thinking") {
				const tc = block as ThinkingContent;
				if (tc.redacted || !tc.thinking) continue;
				const lines = tc.thinking.split("\n").filter((l: string) => l.trim());
				const preview = lines.slice(-PLANNER_THINKING_MAX_LINES).join("\n");
				return preview.length > PLANNER_THINKING_MAX_CHARS
					? `…${preview.slice(-PLANNER_THINKING_MAX_CHARS)}`
					: preview;
			}
		}
	}
	return "";
}

function inferPlannerPhase(toolCalls: string[], liveOutput: string, thinkingPreview: string): string {
	if (liveOutput) return "responding";

	for (let i = toolCalls.length - 1; i >= 0; i--) {
		const call = toolCalls[i];
		const subagentMatch = call.match(/^subagent\s+([^:]+?)(?:\:|$)/);
		if (subagentMatch) {
			const delegatedAgent = subagentMatch[1]?.trim();
			if (delegatedAgent && delegatedAgent !== "parallel") {
				return `consulting ${delegatedAgent}`;
			}
			return "delegating research";
		}
	}

	if (toolCalls.length > 0) return "using tools";
	if (thinkingPreview) return "thinking";
	return "starting";
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let planningInFlight = false;
	let todoItems: TodoItem[] = [];
	let lastPlanRequest = "";
	let lastPlanText = "";
	let plannerAgent = PLANNER_AGENT_NAME;
	let plannerPhase = "";
	let plannerRecentToolCalls: string[] = [];
	let plannerLiveOutput = "";
	let plannerIdleStatus = "";
	let plannerInfoLines: string[] = [];
	let plannerSpinnerInterval: ReturnType<typeof setInterval> | null = null;
	let plannerSpinnerFrame = 0;
	let executionHeartbeatInterval: ReturnType<typeof setInterval> | null = null;
	let executionHeartbeatStartedAt = 0;
	let executionSpinnerFrame = 0;
	let plannerThinkingPreview = "";
	let plannerUsage: UsageStats | null = null;
	let plannerModel = "";
	let plannerPhaseLabel = "Analyzing";
	let executionResumeMessage = "";
	let planFilePath = "";
	let planTitle = "";
	let currentCtx: ExtensionContext | undefined;


	function syncPlanModeFromSharedAgentModes(): void {
		const sharedMode = getSharedAgentModesApi()?.getMode();
		planModeEnabled = sharedMode === "plan";
	}

	async function setSharedAgentMode(
		mode: SharedAgentMode,
		ctx: ExtensionContext,
		notify = false,
	): Promise<boolean> {
		const api = getSharedAgentModesApi();
		if (!api) {
			if (notify) {
				ctx.ui.notify("Shared plan mode unavailable. Load extensions/agent-modes first.", "error");
			}
			planModeEnabled = false;
			updateStatus(ctx);
			return false;
		}
		const changed = await api.setMode(mode, { notify });
		syncPlanModeFromSharedAgentModes();
		updateStatus(ctx);
		return changed;
	}

	function clearPlannerSpinner(): void {
		if (plannerSpinnerInterval !== null) {
			clearInterval(plannerSpinnerInterval);
			plannerSpinnerInterval = null;
		}
	}

	function clearExecutionHeartbeat(): void {
		if (executionHeartbeatInterval !== null) {
			clearInterval(executionHeartbeatInterval);
			executionHeartbeatInterval = null;
		}
		executionHeartbeatStartedAt = 0;
		executionSpinnerFrame = 0;
	}

	function setPlannerIdleState(status: string, infoLines: string[] = []): void {
		plannerIdleStatus = status;
		plannerInfoLines = infoLines;
	}

	function clearPlannerIdleState(): void {
		plannerIdleStatus = "";
		plannerInfoLines = [];
		executionResumeMessage = "";
	}

	function getCompletedTodoCount(): number {
		return todoItems.filter((item) => item.completed).length;
	}

	function getNextTodoItem(): TodoItem | undefined {
		return todoItems.find((item) => !item.completed);
	}

	function getElapsedSeconds(startedAt: number): number {
		return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
	}

	function reportPlannerMessage(customType: string, content: string): void {
		pi.sendMessage({ customType, content, display: true }, { triggerTurn: false });
	}

	function reportPlannerFailure(ctx: ExtensionContext, message: string, cause = ""): void {
		const phase = plannerPhase || "starting";
		const lines = [`✗ Planner failed during ${phase}: ${message}`];
		if (cause) lines.push(`Cause: ${cause}`);
		const detail = lines.join("\n");
		ctx.ui.notify(detail, "error");
		reportPlannerMessage("plan-planner-error", detail);
	}

	function getAllAssistantText(result: SingleResult): string {
		const parts: string[] = [];
		for (const msg of getVisibleMessages(result)) {
			if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
			for (const block of msg.content) {
				if (block.type === "text" && (block as TextContent).text) {
					parts.push((block as TextContent).text);
				}
			}
		}
		return parts.join("\n\n");
	}

	function writePlanFile(ctx: ExtensionContext, text: string): string {
		try {
			const sessionDir = ctx.sessionManager.getSessionDir();
			const sessionId = ctx.sessionManager.getSessionId();
			const filePath = path.join(sessionDir, `${sessionId}-PLAN.md`);
			fs.writeFileSync(filePath, text, "utf-8");
			return filePath;
		} catch (err) {
			ctx.ui.notify(`Failed to write plan file: ${err instanceof Error ? err.message : String(err)}`, "warning");
			return "";
		}
	}

	function startPlannerSpinner(ctx: ExtensionContext): void {
		clearPlannerSpinner();
		plannerSpinnerFrame = 0;
		plannerPhaseLabel = "Analyzing";
		plannerPhase = `${SPINNER_FRAMES[plannerSpinnerFrame]} ${plannerPhaseLabel}…`;
		updateStatus(ctx);
		plannerSpinnerInterval = setInterval(() => {
			if (!planningInFlight) {
				clearPlannerSpinner();
				return;
			}
			plannerSpinnerFrame = (plannerSpinnerFrame + 1) % SPINNER_FRAMES.length;
			plannerPhase = `${SPINNER_FRAMES[plannerSpinnerFrame]} ${plannerPhaseLabel}…`;
			updateStatus(ctx);
		}, PLANNER_SPINNER_INTERVAL_MS);
	}

	function startExecutionHeartbeat(ctx: ExtensionContext): void {
		if (!executionMode || todoItems.length === 0) return;
		clearExecutionHeartbeat();
		executionResumeMessage = "";
		executionHeartbeatStartedAt = Date.now();
		executionSpinnerFrame = 0;
		updateStatus(ctx);
		executionHeartbeatInterval = setInterval(() => {
			if (!executionMode || todoItems.length === 0) {
				clearExecutionHeartbeat();
				return;
			}
			executionSpinnerFrame = (executionSpinnerFrame + 1) % SPINNER_FRAMES.length;
			updateStatus(ctx);
		}, EXECUTION_HEARTBEAT_INTERVAL_MS);
	}

	function updatePlannerLiveState(result: SingleResult): boolean {
		const displayItems = getVisibleDisplayItems(result);
		const toolCalls: string[] = [];
		for (const item of displayItems) {
			const summary = summarizeToolCall(item);
			if (!summary) continue;
			if (toolCalls[toolCalls.length - 1] !== summary) toolCalls.push(summary);
		}

		const recentToolCalls = toolCalls.slice(-PLANNER_RECENT_TOOL_LIMIT);
		const liveOutput = buildPlannerOutputPreview(getVisibleOutput(result));
		const thinkingPreview = getThinkingPreview(result);
		const rawPhase = inferPlannerPhase(recentToolCalls, liveOutput, thinkingPreview);
		const newLabel = phaseToLabel(rawPhase);
		const changed =
			newLabel !== plannerPhaseLabel ||
			liveOutput !== plannerLiveOutput ||
			thinkingPreview !== plannerThinkingPreview ||
			recentToolCalls.join("\n") !== plannerRecentToolCalls.join("\n");

		plannerPhaseLabel = newLabel;
		plannerPhase = `${SPINNER_FRAMES[plannerSpinnerFrame]} ${plannerPhaseLabel}…`;
		plannerRecentToolCalls = recentToolCalls;
		plannerLiveOutput = liveOutput;
		plannerThinkingPreview = thinkingPreview;
		plannerUsage = result.usage;
		plannerModel = result.model || "";
		return changed;
	}


	pi.registerTool({
		name: "exit_plan_mode",
		label: "Exit Plan Mode",
		description:
			"Signal that the plan is complete. Call this when you have finished writing your plan to a Plan: header with numbered steps. Provide a short descriptive title.",
		parameters: Type.Object({
			title: Type.String({ description: "Short descriptive title for the plan (e.g. 'AUTH_MIGRATION')" }),
		}),
		async execute(_toolCallId, params) {
			const title = typeof params.title === "string" ? params.title.trim() : "";
			return {
				content: [{ type: "text" as const, text: `Plan complete. Title: ${title || "(untitled)"}` }],
			};
		},
	});


	function resetPlannerLiveState(): void {
		clearPlannerSpinner();
		plannerPhase = "";
		plannerPhaseLabel = "Analyzing";
		plannerRecentToolCalls = [];
		plannerLiveOutput = "";
		plannerThinkingPreview = "";
		plannerUsage = null;
		plannerModel = "";
	}

	function resetPlanState(): void {
		clearExecutionHeartbeat();
		executionMode = false;
		planningInFlight = false;
		todoItems = [];
		lastPlanText = "";
		planFilePath = "";
		planTitle = "";
		clearPlannerIdleState();
		resetPlannerLiveState();
	}

	async function enablePlanMode(ctx: ExtensionContext, notify = true): Promise<boolean> {
		return setSharedAgentMode("plan", ctx, notify);
	}

	async function disablePlanMode(
		ctx: ExtensionContext,
		notify = true,
		targetMode: SharedAgentMode = "off",
	): Promise<boolean> {
		return setSharedAgentMode(targetMode, ctx, notify);
	}


	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
			lastPlanRequest,
			lastPlanText,
			plannerAgent,
			planFilePath,
			planTitle,
		} satisfies PlanModeStateData);
	}

	function buildPlannerWidgetLines(ctx: ExtensionContext): string[] | undefined {
		if (planningInFlight) {
			const plannerLines = [
				ctx.ui.theme.fg("accent", `Planner: ${plannerAgent}`),
				ctx.ui.theme.fg("muted", `Status: ${plannerPhase || "starting"}`),
				ctx.ui.theme.fg("dim", shortenRequest(lastPlanRequest) || "Waiting for request"),
			];
			if (plannerThinkingPreview) {
				plannerLines.push(ctx.ui.theme.fg("muted", "Thinking:"));
				for (const line of plannerThinkingPreview.split("\n")) {
					plannerLines.push(ctx.ui.theme.fg("dim", line));
				}
			}
			if (plannerRecentToolCalls.length > 0) {
				plannerLines.push(ctx.ui.theme.fg("muted", "Tools:"));
				for (const call of plannerRecentToolCalls) {
					plannerLines.push(ctx.ui.theme.fg("dim", `→ ${call}`));
				}
			}
			if (plannerLiveOutput) {
				plannerLines.push(ctx.ui.theme.fg("muted", "Live output:"));
				for (const line of plannerLiveOutput.split("\n")) {
					plannerLines.push(line);
				}
			}
			if (plannerUsage) {
				const usageStr = formatPlannerUsage(plannerUsage, plannerModel);
				if (usageStr) {
					plannerLines.push(ctx.ui.theme.fg("dim", usageStr));
				}
			}
			return plannerLines;
		}

		if (executionMode && todoItems.length > 0) {
			const nextItem = getNextTodoItem();
			if (!nextItem) return undefined;
			const elapsed =
				executionHeartbeatStartedAt > 0 ? ` (${getElapsedSeconds(executionHeartbeatStartedAt)}s)` : "";
			const spinner = SPINNER_FRAMES[executionSpinnerFrame] ?? SPINNER_FRAMES[0];
			const status = executionHeartbeatStartedAt > 0
				? `${spinner} Running step ${nextItem.step}/${todoItems.length}…${elapsed}`
				: `Next step ${nextItem.step}/${todoItems.length}`;
			const lines = [
				ctx.ui.theme.fg("accent", "Execution"),
				ctx.ui.theme.fg("muted", status),
			];
			if (executionResumeMessage) {
				lines.push(ctx.ui.theme.fg("dim", executionResumeMessage));
			}
			lines.push(ctx.ui.theme.fg("dim", nextItem.text));
			return lines;
		}

		if (planModeEnabled && lastPlanRequest.trim()) {
			const lines = [
				ctx.ui.theme.fg("accent", `Planner: ${plannerAgent}`),
				ctx.ui.theme.fg("muted", shortenRequest(lastPlanRequest)),
			];
			if (plannerIdleStatus) {
				lines.push(ctx.ui.theme.fg("muted", `Status: ${plannerIdleStatus}`));
			}
			for (const line of plannerInfoLines) {
				lines.push(ctx.ui.theme.fg("dim", line));
			}
			if (plannerUsage) {
				const usageStr = formatPlannerUsage(plannerUsage, plannerModel);
				if (usageStr) {
					lines.push(ctx.ui.theme.fg("dim", usageStr));
				}
			}
			return lines;
		}

		return undefined;
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (planningInFlight) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `🧠 ${plannerAgent}`));
		} else if (executionMode && todoItems.length > 0) {
			const completed = getCompletedTodoCount();
			const elapsed = executionHeartbeatStartedAt > 0 ? ` · ${getElapsedSeconds(executionHeartbeatStartedAt)}s` : "";
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}${elapsed}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		ctx.ui.setWidget("plan-planner", buildPlannerWidgetLines(ctx));

		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function setPlanFromText(planText: string): void {
		lastPlanText = planText.trim();
		const decision = getPlannerDecision(lastPlanText);
		if (decision !== "plan") {
			todoItems = [];
			return;
		}
		const extracted = extractTodoItems(lastPlanText);
		todoItems = extracted.length > 0 ? extracted : [];
	}

	function buildPlannerTask(request: string, currentPlanText = "", refinement?: string): string {
		const sections = [
			"Create a read-only implementation plan for this repository.",
			"Inspect the relevant code before answering.",
			"You must choose exactly one outcome.",
			"",
			"OUTCOME 1 — PLAN:",
			"If the request is specific enough to plan safely:",
			"1. Output your plan with an exact `Plan:` header followed by numbered steps.",
			"2. When done, call the `exit_plan_mode` tool with a short descriptive title.",
			"IMPORTANT: Call `exit_plan_mode` to signal completion. Do NOT write `Decision: PLAN`.",
			"",
			"OUTCOME 2 — NEEDS_MORE_DETAIL:",
			"If the request is too vague to plan safely, start with `Decision: NEEDS_MORE_DETAIL` and then output an exact `Need more detail:` header followed by 1-3 short bullet points.",
			"Each bullet must be a single independently answerable clarification question.",
			"Do NOT call `exit_plan_mode` in this case.",
			"",
			"General rules:",
			"- Never output both outcomes.",
			"- Do not include code patches or `[DONE:n]` markers.",
			"- If information is missing but you can still proceed safely, make the smallest reasonable assumption and list it briefly before the plan.",
			"- Keep the plan scoped to the request.",
			"",
			"Examples:",
			"Input: test",
			"Decision: NEEDS_MORE_DETAIL",
			"",
			"Need more detail:",
			"- What exactly should be tested or changed?",
			"- Which files, module, or feature area are involved?",
			"",
			"Input: add planner status while /plan is running in extensions/plan-mode/index.ts",
			"(Agent outputs plan with Plan: header and numbered steps, then calls exit_plan_mode with title 'ADD_PLANNER_STATUS')",
			"",
			"User request:",
			 request,
		];

		if (currentPlanText.trim()) {
			sections.push("", "Current plan:", currentPlanText.trim());
		}
		if (refinement?.trim()) {
			sections.push("", "Refinement feedback:", refinement.trim());
		}

		return sections.join("\n");
	}

	async function collectPlannerClarifications(ctx: ExtensionContext): Promise<string | null> {
		const questions = extractNeedMoreDetailQuestions(lastPlanText);
		if (questions.length === 0) {
			const refinement = await ctx.ui.editor("Add more detail for the planner:", lastPlanRequest);
			if (!refinement?.trim()) return null;
			setPlannerIdleState("◐ Replanning with your input…", [
				`✓ Answered: ${shortenRequest(refinement.trim(), 96)}`,
			]);
			updateStatus(ctx);
			return refinement.trim();
		}

		ctx.ui.notify(`Answer ${questions.length} planner question${questions.length === 1 ? "" : "s"} one by one.`, "info");
		setPlannerIdleState(`Waiting for answer 1/${questions.length}`);
		updateStatus(ctx);

		const answers: Array<{ question: string; answer: string }> = [];
		for (let i = 0; i < questions.length; i++) {
			const question = questions[i];
			const answer = await ctx.ui.editor(`Planner question ${i + 1}/${questions.length}:\n\n${question}`, "");
			if (!answer?.trim()) return null;
			answers.push({ question, answer: answer.trim() });
			setPlannerIdleState(
				`Collected ${answers.length}/${questions.length} answers`,
				answers.map((item) => `✓ Answered: ${shortenRequest(item.answer, 96)}`),
			);
			updateStatus(ctx);
		}

		setPlannerIdleState(
			"◐ Replanning with your input…",
			answers.map((item) => `✓ Answered: ${shortenRequest(item.answer, 96)}`),
		);
		updateStatus(ctx);

		const lines = [lastPlanRequest.trim(), "", "Additional detail:"];
		for (const item of answers) {
			lines.push(`- ${item.question}`, `  Answer: ${item.answer}`);
		}
		return lines.join("\n").trim();
	}

	async function runPlanner(request: string, ctx: ExtensionContext, refinement?: string): Promise<void> {
		const currentPlanText = lastPlanText;
		if (!(await enablePlanMode(ctx, false))) return;
		resetPlanState();
		lastPlanRequest = request.trim();
		plannerAgent = PLANNER_AGENT_NAME;
		planningInFlight = true;
		startPlannerSpinner(ctx);
		persistState();
		reportPlannerMessage(
			"plan-planner-status",
			`**Planning with ${plannerAgent}...**\n\n${shortenRequest(lastPlanRequest, 160)}`,
		);
		ctx.ui.notify(`Planning with ${plannerAgent}...`, "info");

		const discovery = discoverAgents(ctx.cwd, "user");
		if (!discovery.agents.some((agent) => agent.name === plannerAgent)) {
			planningInFlight = false;
			updateStatus(ctx);
			persistState();
			const message = `Planner agent \"${plannerAgent}\" not found. Add agents/${plannerAgent}.md first.`;
			ctx.ui.notify(message, "error");
			reportPlannerMessage("plan-planner-error", `✗ ${message}`);
			return;
		}

		let result: SingleResult;
		try {
			result = await runAgent({
				cwd: ctx.cwd,
				agents: discovery.agents,
				agentName: plannerAgent,
				task: buildPlannerTask(request, currentPlanText, refinement),
				taskCwd: ctx.cwd,
				delegationMode: PLANNER_DELEGATION_MODE,
				parentDepth: 0,
				parentAgentStack: [],
				maxDepth: 3,
				preventCycles: true,
				makeDetails: (results) => createSubagentDetails(results, discovery.projectAgentsDir),
				onUpdate: (partial) => {
					const liveResult = partial.details?.results[0];
					if (!liveResult) return;
					if (!updatePlannerLiveState(liveResult)) return;
					updateStatus(ctx);
				},
			});
		} catch (error) {
			planningInFlight = false;
			updateStatus(ctx);
			persistState();
			const message = error instanceof Error ? error.message : String(error);
			const cause =
				error instanceof Error && error.cause !== undefined
					? error.cause instanceof Error
						? error.cause.message
						: String(error.cause)
					: "";
			reportPlannerFailure(ctx, message, cause);
			return;
		}

		planningInFlight = false;
		clearPlannerSpinner();
		updatePlannerLiveState(result);
		updateStatus(ctx);

		// Detect exit_plan_mode tool call (Priority 3)
		const displayItems = getVisibleDisplayItems(result);
		const exitToolCall = displayItems.find(
			(item) => item.type === "toolCall" && item.name === "exit_plan_mode",
		);
		let planText: string;
		if (exitToolCall) {
			// Agent signaled completion via tool — use all assistant text as plan
			planTitle = getStringArg(exitToolCall.args ?? {}, "title");
			planText = getAllAssistantText(result).trim();
		} else {
			// Fallback: parse from last assistant message (backward compat)
			planTitle = "";
			planText = getResultSummaryText(result).trim();
		}

		if (isResultError(result)) {
			persistState();
			reportPlannerFailure(ctx, planText || `${plannerAgent} returned an error.`);
			return;
		}

		setPlanFromText(planText);
		reportPlannerMessage("plan-planner-output", planText || "(no output)");

		// Write plan to file (Priority 1)
		if (todoItems.length > 0 && planText) {
			planFilePath = writePlanFile(ctx, planText);
		}

		if (todoItems.length === 0) {
			const decision = exitToolCall ? "plan" : getPlannerDecision(planText);
			if (decision === "plan") {
				ctx.ui.notify("Could not extract numbered steps from the planner response.", "warning");
				reportPlannerMessage(
					"plan-extraction-warning",
					["⚠ Could not extract numbered steps from the planner response.", "", "Try: make a concrete plan with numbered steps."].join("\n"),
				);
			} else if (decision === "unknown") {
				const preview = planText.split("\n").slice(0, 6).join("\n").trim() || "(no output)";
				ctx.ui.notify(`${plannerAgent} returned an unrecognized response. Refine the request and try again.`, "warning");
				reportPlannerMessage(
					"plan-extraction-warning",
					[
						`⚠ ${plannerAgent} returned an unrecognized response.`,
						"",
						"Try: make a concrete plan with numbered steps.",
						"",
						"Raw output preview:",
						preview,
					].join("\n"),
				);
			}
			if (decision === "needs_more_detail") {
				ctx.ui.notify(`${plannerAgent} needs a more specific request before it can build a plan.`, "info");
			}
		}

		updateStatus(ctx);
		persistState();
		await presentPlanActions(ctx);
	}

	async function presentPlanActions(ctx: ExtensionContext): Promise<void> {
		const plannerDecision = getPlannerDecision(lastPlanText);
		const needsMoreDetail = plannerDecision === "needs_more_detail";
		if (todoItems.length > 0) {
			const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
			pi.sendMessage(
				{
					customType: "plan-todo-list",
					content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		}

		persistState();

		const options = todoItems.length > 0
			? ["Execute the plan (track progress)", "Stay in plan mode", "Refine the plan"]
			: [needsMoreDetail ? "Answer planner questions (1 by 1)" : "Refine the request", "Stay in plan mode"];
		const choice = await ctx.ui.select("Plan mode - what next?", options);

		if (choice?.startsWith("Execute")) {
			await disablePlanMode(ctx, false, "code");
			executionMode = todoItems.length > 0;
			updateStatus(ctx);
			persistState();

			const execMessage =
				todoItems.length > 0
					? `Execute the plan. Start with: ${todoItems[0].text}`
					: "Execute the plan you just created.";
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: execMessage, display: true },
				{ triggerTurn: true },
			);
			return;
		}

		if (choice === "Refine the plan" || choice === "Answer planner questions (1 by 1)" || choice === "Refine the request") {
			const refineRequest = choice === "Answer planner questions (1 by 1)" || choice === "Refine the request";
			const refinement = refineRequest
				? await collectPlannerClarifications(ctx)
				: await ctx.ui.editor("Refine the plan:", "");
			if (!refinement?.trim()) return;
			if (refineRequest) {
				await runPlanner(refinement.trim(), ctx);
				return;
			}
			const request = lastPlanRequest.trim() || "Refine the current plan for this repository.";
			await runPlanner(request, ctx, refinement.trim());
		}
	}

	pi.registerCommand("plan", {
		description: "Run the Prometheus planner while already in /agent-mode plan",
		handler: async (args, ctx) => {
			if (!planModeEnabled) {
				ctx.ui.notify("Enter plan mode first with /agent-mode plan.", "info");
				return;
			}
			const request = args.trim() || (await ctx.ui.editor("Plan request:", lastPlanRequest)).trim();
			if (!request) return;
			await runPlanner(request, ctx);
		},
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Enter /agent-mode plan, then run /plan.", "info");
				return;
			}
			const list = todoItems.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});


	pi.events.on("agent-mode:changed", (data) => {
		const payload = data as { mode?: SharedAgentMode };
		if (!payload.mode) return;
		planModeEnabled = payload.mode === "plan";
		if (!currentCtx) return;
		updateStatus(currentCtx);
		persistState();
	});


	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		// Priority 2: Aggressively trim planning messages during execution
		if (executionMode && todoItems.length > 0) {
			const executeIdx = event.messages.findIndex((m) => {
				const msg = m as AgentMessage & { customType?: string };
				return msg.customType === "plan-mode-execute";
			});
			if (executeIdx >= 0) {
				// Keep only messages from the execution trigger onward
				return { messages: event.messages.slice(executeIdx) };
			}
		}

		// Default: filter hidden plan message types
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType && HIDDEN_PLAN_MESSAGE_TYPES.has(msg.customType)) return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: read, bash, grep, find, ls, ask
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to an allowlist of read-only commands

Ask clarifying questions using the ask tool.
Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			startExecutionHeartbeat(ctx);
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			const planFileRef = planFilePath ? `\nFull plan file: ${planFilePath}\nUse the read tool to review the full plan if needed.` : "";
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]${planFileRef}

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
					display: false,
				},
			};
		}
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		startExecutionHeartbeat(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		clearExecutionHeartbeat();
		if (isAssistantMessage(event.message)) {
			const text = getTextContent(event.message);
			markCompletedSteps(text, todoItems);
		}
		updateStatus(ctx);
		persistState();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (executionMode && todoItems.length > 0) {
			clearExecutionHeartbeat();
			if (todoItems.every((t) => t.completed)) {
				const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
					{ triggerTurn: false },
				);
				executionMode = false;
				todoItems = [];
				executionResumeMessage = "";
				updateStatus(ctx);
				persistState();
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		const lastUser = [...event.messages].reverse().find((message) => message.role === "user");
		if (lastUser) {
			lastPlanRequest = getUserText(lastUser);
		}
		if (lastAssistant) {
			setPlanFromText(getTextContent(lastAssistant));
		}

		if (todoItems.length === 0) {
			const decision = getPlannerDecision(lastPlanText);
			ctx.ui.notify(
				decision === "needs_more_detail"
					? "Need a more specific request before a plan can be generated."
					: "Planner returned an unrecognized response. Refine the request and try again.",
				decision === "needs_more_detail" ? "info" : "warning",
			);
		}

		updateStatus(ctx);
		await presentPlanActions(ctx);
	});

	pi.on("session_shutdown", async () => {
		currentCtx = undefined;
		clearPlannerSpinner();
		clearExecutionHeartbeat();
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;

		const entries = ctx.sessionManager.getEntries();

		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: PlanModeStateData } | undefined;

		if (planModeEntry?.data) {
			syncPlanModeFromSharedAgentModes();
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			lastPlanRequest = planModeEntry.data.lastPlanRequest ?? lastPlanRequest;
			lastPlanText = planModeEntry.data.lastPlanText ?? lastPlanText;
			plannerAgent = planModeEntry.data.plannerAgent ?? plannerAgent;
			planFilePath = planModeEntry.data.planFilePath ?? planFilePath;
			planTitle = planModeEntry.data.planTitle ?? planTitle;
		}
		planningInFlight = false;
		clearPlannerSpinner();
		clearExecutionHeartbeat();

		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems);
			const completed = getCompletedTodoCount();
			const remaining = todoItems.length - completed;
			const nextStep = getNextTodoItem();
			executionResumeMessage = `Resumed plan: ${completed}/${todoItems.length} completed. ${remaining} remaining.`;
			ctx.ui.notify(
				nextStep
					? `${executionResumeMessage} Next: ${nextStep.text}`
					: executionResumeMessage,
				"info",
			);
		}

		syncPlanModeFromSharedAgentModes();
		updateStatus(ctx);
	});
}
