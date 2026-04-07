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
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { discoverAgents } from "../subagent/agents.js";
import { getResultSummaryText } from "../subagent/runner-events.js";
import { runAgent } from "../subagent/runner.js";
import {
	getVisibleDisplayItems,
	getVisibleOutput,
	isResultError,
	type DisplayItem,
	type SingleResult,
	type SubagentDetails,
} from "../subagent/types.js";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils.js";

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "ask"];
const PLANNER_AGENT_NAME = "prometheus";
const PLANNER_DELEGATION_MODE = "spawn";
const PLANNER_RECENT_TOOL_LIMIT = 3;
const PLANNER_OUTPUT_MAX_LINES = 12;
const PLANNER_OUTPUT_MAX_CHARS = 1400;
const HIDDEN_PLAN_MESSAGE_TYPES = new Set([
	"plan-mode-context",
	"plan-planner-status",
	"plan-planner-progress",
	"plan-planner-output",
	"plan-todo-list",
	"plan-complete",
]);

type PlannerDecision = "plan" | "needs_more_detail" | "unknown";

interface PlanModeStateData {
	enabled: boolean;
	todos?: TodoItem[];
	executing?: boolean;
	lastPlanRequest?: string;
	lastPlanText?: string;
	plannerAgent?: string;
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
	let preview = previewLines.join("\n");
	if (lines.length > previewLines.length) preview = `...\n${preview}`;
	if (preview.length > PLANNER_OUTPUT_MAX_CHARS) {
		preview = `...${preview.slice(-(PLANNER_OUTPUT_MAX_CHARS - 3))}`;
	}
	return preview;
}

function inferPlannerPhase(toolCalls: string[], liveOutput: string): string {
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
	return "starting";
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let planningInFlight = false;
	let todoItems: TodoItem[] = [];
	let previousActiveTools: string[] | null = null;
	let lastPlanRequest = "";
	let lastPlanText = "";
	let plannerAgent = PLANNER_AGENT_NAME;
	let plannerPhase = "";
	let plannerRecentToolCalls: string[] = [];
	let plannerLiveOutput = "";

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
		const phase = inferPlannerPhase(recentToolCalls, liveOutput);
		const changed =
			phase !== plannerPhase ||
			liveOutput !== plannerLiveOutput ||
			recentToolCalls.join("\n") !== plannerRecentToolCalls.join("\n");

		plannerPhase = phase;
		plannerRecentToolCalls = recentToolCalls;
		plannerLiveOutput = liveOutput;
		return changed;
	}

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function rememberActiveTools(): void {
		if (previousActiveTools === null) {
			previousActiveTools = pi.getActiveTools();
		}
	}

	function restoreActiveTools(): void {
		if (previousActiveTools !== null) {
			pi.setActiveTools(previousActiveTools);
			previousActiveTools = null;
		}
	}

	function resetPlannerLiveState(): void {
		plannerPhase = "";
		plannerRecentToolCalls = [];
		plannerLiveOutput = "";
	}

	function resetPlanState(): void {
		executionMode = false;
		planningInFlight = false;
		todoItems = [];
		lastPlanText = "";
		resetPlannerLiveState();
	}

	function enablePlanMode(ctx: ExtensionContext, notify = true): void {
		if (!planModeEnabled) {
			planModeEnabled = true;
			rememberActiveTools();
			pi.setActiveTools(PLAN_MODE_TOOLS);
			if (notify) {
				ctx.ui.notify(`Plan mode enabled. Tools: ${PLAN_MODE_TOOLS.join(", ")}`);
			}
		}
	}

	function disablePlanMode(ctx: ExtensionContext, notify = true): void {
		if (!planModeEnabled) return;
		planModeEnabled = false;
		restoreActiveTools();
		if (notify) {
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		}
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		if (planModeEnabled) {
			disablePlanMode(ctx);
			resetPlanState();
			lastPlanRequest = "";
			plannerAgent = PLANNER_AGENT_NAME;
		} else {
			resetPlanState();
			lastPlanRequest = "";
			plannerAgent = PLANNER_AGENT_NAME;
			enablePlanMode(ctx);
		}
		updateStatus(ctx);
		persistState();
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
			lastPlanRequest,
			lastPlanText,
			plannerAgent,
		} satisfies PlanModeStateData);
	}

	function buildPlannerWidgetLines(ctx: ExtensionContext): string[] | undefined {
		if (planningInFlight) {
			const plannerLines = [
				ctx.ui.theme.fg("accent", `Planner: ${plannerAgent}`),
				ctx.ui.theme.fg("muted", `Status: ${plannerPhase || "starting"}`),
				ctx.ui.theme.fg("dim", shortenRequest(lastPlanRequest) || "Waiting for request"),
			];
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
			return plannerLines;
		}

		if (planModeEnabled && lastPlanRequest.trim()) {
			return [
				ctx.ui.theme.fg("accent", `Planner: ${plannerAgent}`),
				ctx.ui.theme.fg("muted", shortenRequest(lastPlanRequest)),
			];
		}

		return undefined;
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (planningInFlight) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `🧠 ${plannerAgent}`));
		} else if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
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
			"You must choose exactly one outcome and make it explicit on the first decision line.",
			"If the request is specific enough to plan safely, start with `Decision: PLAN` and then output an exact `Plan:` header followed by numbered steps.",
			"If the request is too vague to plan safely, start with `Decision: NEEDS_MORE_DETAIL` and then output an exact `Need more detail:` header followed by 1-3 short bullet points.",
			"Never output both outcomes.",
			"Do not include code patches or `[DONE:n]` markers.",
			"If information is missing but you can still proceed safely, make the smallest reasonable assumption and list it briefly before the plan.",
			"Each NEEDS_MORE_DETAIL bullet must be a single independently answerable clarification question.",
			"Keep the plan scoped to the request.",
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
			"Decision: PLAN",
			"",
			"Plan:",
			"1. Review the current planner status flow in extensions/plan-mode/index.ts.",
			"2. Add a visible planner-running indicator for /plan invocations.",
			"3. Verify the execution flow still works after planning completes.",
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
			return refinement?.trim() ? refinement.trim() : null;
		}

		ctx.ui.notify(`Answer ${questions.length} planner question${questions.length === 1 ? "" : "s"} one by one.`, "info");
		const answers: Array<{ question: string; answer: string }> = [];
		for (let i = 0; i < questions.length; i++) {
			const question = questions[i];
			const answer = await ctx.ui.editor(`Planner question ${i + 1}/${questions.length}:\n\n${question}`, "");
			if (!answer?.trim()) return null;
			answers.push({ question, answer: answer.trim() });
		}

		const lines = [lastPlanRequest.trim(), "", "Additional detail:"];
		for (const item of answers) {
			lines.push(`- ${item.question}`, `  Answer: ${item.answer}`);
		}
		return lines.join("\n").trim();
	}

	async function runPlanner(request: string, ctx: ExtensionContext, refinement?: string): Promise<void> {
		const currentPlanText = lastPlanText;
		enablePlanMode(ctx, false);
		resetPlanState();
		lastPlanRequest = request.trim();
		plannerAgent = PLANNER_AGENT_NAME;
		planningInFlight = true;
		updateStatus(ctx);
		persistState();
		pi.sendMessage(
			{
				customType: "plan-planner-status",
				content: `**Planning with ${plannerAgent}...**\n\n${shortenRequest(lastPlanRequest, 160)}`,
				display: true,
			},
			{ triggerTurn: false },
		);
		ctx.ui.notify(`Planning with ${plannerAgent}...`, "info");

		const discovery = discoverAgents(ctx.cwd, "user");
		if (!discovery.agents.some((agent) => agent.name === plannerAgent)) {
			planningInFlight = false;
			updateStatus(ctx);
			persistState();
			ctx.ui.notify(`Planner agent \"${plannerAgent}\" not found. Add agents/${plannerAgent}.md first.`, "error");
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
			ctx.ui.notify(`${plannerAgent} failed: ${message}`, "error");
			return;
		}

		planningInFlight = false;
		updatePlannerLiveState(result);
		updateStatus(ctx);
		const planText = getResultSummaryText(result).trim();
		if (isResultError(result)) {
			updateStatus(ctx);
			persistState();
			ctx.ui.notify(`${plannerAgent} failed: ${planText}`, "error");
			return;
		}

		setPlanFromText(planText);
		pi.sendMessage(
			{ customType: "plan-planner-output", content: planText || "(no output)", display: true },
			{ triggerTurn: false },
		);

		if (todoItems.length === 0) {
			const decision = getPlannerDecision(planText);
			ctx.ui.notify(
				decision === "needs_more_detail"
					? `${plannerAgent} needs a more specific request before it can build a plan.`
					: `${plannerAgent} returned an unrecognized response. Refine the request and try again.`,
				decision === "needs_more_detail" ? "info" : "warning",
			);
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
			disablePlanMode(ctx, false);
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
		description: "Toggle plan mode, or run /plan {request} with the Prometheus planner",
		handler: async (args, ctx) => {
			const request = args.trim();
			if (!request) {
				togglePlanMode(ctx);
				return;
			}
			await runPlanner(request, ctx);
		},
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}
			const list = todoItems.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	pi.on("context", async (event) => {
		if (planModeEnabled) return;

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

	pi.on("before_agent_start", async () => {
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
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
					display: false,
				},
			};
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, todoItems) > 0) {
			updateStatus(ctx);
		}
		persistState();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
					{ triggerTurn: false },
				);
				executionMode = false;
				todoItems = [];
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

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();

		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: PlanModeStateData } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			lastPlanRequest = planModeEntry.data.lastPlanRequest ?? lastPlanRequest;
			lastPlanText = planModeEntry.data.lastPlanText ?? lastPlanText;
			plannerAgent = planModeEntry.data.plannerAgent ?? plannerAgent;
		}
		planningInFlight = false;

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
		}

		if (planModeEnabled) {
			rememberActiveTools();
			pi.setActiveTools(PLAN_MODE_TOOLS);
		}
		updateStatus(ctx);
	});
}
