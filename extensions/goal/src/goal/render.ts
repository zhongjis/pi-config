/**
 * Local addition (not upstream): compact TUI presentation for the goal tools.
 *
 * Collapsed view shows owner-parsed workflow state; expanded view returns the
 * exact raw `result.content`. Model-visible `result.content` is never mutated.
 */
import {
	extractToolText,
	firstMeaningfulLine,
	renderToolCall,
	renderToolExpanded,
	renderToolSummary,
} from "../../../lib/tool-output.js";
import { formatGoalElapsedSeconds, formatTokensCompact, goalStatusLabel } from "./format.js";
import { GOAL_STATUS_VALUES, type GoalStatus, isRecord } from "./types.js";

export type GoalRenderTheme = {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
};
export type GoalRenderResult = {
	content?: readonly unknown[];
	details?: unknown;
	isError?: boolean;
};
export type GoalRenderOptions = {
	expanded?: boolean;
	isPartial?: boolean;
};
export type GoalRenderContext = {
	args?: Record<string, unknown>;
	isError?: boolean;
};

export type GoalToolName = "create_goal" | "get_goal" | "update_goal";

const MAX_OBJECTIVE_LENGTH = 72;
const MAX_ERROR_LENGTH = 96;

function compactInline(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncateEnd(value: string, maxLength: number): string {
	const chars = Array.from(value);
	if (chars.length <= maxLength) return value;
	if (maxLength <= 1) return "…";
	return `${chars.slice(0, maxLength - 1).join("")}…`;
}

function isGoalStatus(value: unknown): value is GoalStatus {
	return typeof value === "string" && (GOAL_STATUS_VALUES as readonly string[]).includes(value);
}

function positiveFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function renderGoalCall(
	toolName: GoalToolName,
	rawArgs: Record<string, unknown> | undefined,
	theme: GoalRenderTheme,
) {
	const args = isRecord(rawArgs) ? rawArgs : {};
	let target: string | undefined;
	if (toolName === "create_goal" && typeof args.objective === "string") {
		target = `"${truncateEnd(compactInline(args.objective), MAX_OBJECTIVE_LENGTH)}"`;
	} else if (toolName === "update_goal" && typeof args.status === "string") {
		target = args.status;
	}
	return renderToolCall(toolName, target, theme);
}

function parseGoal(text: string): { structured: boolean; goal: unknown } {
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isRecord(parsed) || !("goal" in parsed)) return { structured: false, goal: null };
		return { structured: true, goal: parsed.goal };
	} catch {
		return { structured: false, goal: null };
	}
}

function summarizeGoalResult(
	result: GoalRenderResult | undefined,
	text: string,
	options: GoalRenderOptions,
	context: GoalRenderContext,
): string[] {
	if (options.isPartial) return ["status: running"];
	if (Boolean(result?.isError) || Boolean(context.isError)) {
		return [`error: ${truncateEnd(firstMeaningfulLine(text) || "unknown error", MAX_ERROR_LENGTH)}`];
	}

	const parsed = parseGoal(text);
	if (!parsed.structured) {
		return [`goal: ${truncateEnd(firstMeaningfulLine(text) || "no output", MAX_ERROR_LENGTH)}`];
	}
	if (!isRecord(parsed.goal)) return ["goal: none set"];

	const objective =
		typeof parsed.goal.objective === "string"
			? truncateEnd(compactInline(parsed.goal.objective), MAX_OBJECTIVE_LENGTH)
			: "(unknown)";
	const statusLabel = isGoalStatus(parsed.goal.status)
		? goalStatusLabel(parsed.goal.status)
		: String(parsed.goal.status ?? "unknown");
	const statusParts = [statusLabel];

	const elapsed = positiveFiniteNumber(parsed.goal.timeUsedSeconds);
	if (elapsed !== undefined) statusParts.push(`elapsed ${formatGoalElapsedSeconds(elapsed)}`);

	const tokensUsed = positiveFiniteNumber(parsed.goal.tokensUsed);
	const tokenBudget = positiveFiniteNumber(parsed.goal.tokenBudget);
	if (tokenBudget !== undefined) {
		statusParts.push(`budget ${formatTokensCompact(tokensUsed ?? 0)}/${formatTokensCompact(tokenBudget)} tokens`);
	} else if (tokensUsed !== undefined) {
		statusParts.push(`tokens ${formatTokensCompact(tokensUsed)}`);
	}

	return [`objective: ${objective}`, `status: ${statusParts.join(" · ")}`];
}

function hasUsefulExpansion(
	result: GoalRenderResult | undefined,
	text: string,
	options: GoalRenderOptions,
	context: GoalRenderContext,
): boolean {
	if (options.isPartial || !text.trim()) return false;
	if (Boolean(result?.isError) || Boolean(context.isError)) {
		return text.split(/\r\n?|\n/).filter(line => line.trim()).length > 1 || Array.from(text).length > MAX_ERROR_LENGTH;
	}
	if (parseGoal(text).structured) return true;
	return text.split(/\r\n?|\n/).filter(line => line.trim()).length > 1 || Array.from(text).length > MAX_ERROR_LENGTH;
}

export function renderGoalResult(
	result: GoalRenderResult | undefined,
	options: GoalRenderOptions | undefined,
	theme: GoalRenderTheme,
	context: GoalRenderContext | undefined,
) {
	const text = extractToolText(result);
	if (options?.expanded) return renderToolExpanded(text);

	const resolvedOptions = options ?? {};
	const resolvedContext = context ?? {};
	const lines = summarizeGoalResult(result, text, resolvedOptions, resolvedContext);
	return renderToolSummary(lines, theme, {
		expandable: hasUsefulExpansion(result, text, resolvedOptions, resolvedContext),
	});
}
