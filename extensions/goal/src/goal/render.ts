/**
 * Local addition (not upstream): compact TUI presentation for the goal tools.
 *
 * Collapsed view shows scan-friendly `keyword: content` lines; expanded view
 * returns the exact raw `result.content`. Model-visible `result.content` is
 * never mutated here — see the `pi-tool-output-presentation` skill and this
 * extension's AGENTS.md `## Local Tweaks`.
 */
import { keyHint } from "@earendil-works/pi-coding-agent";
// @ts-expect-error repo test/runtime alias resolves @earendil-works/pi-tui; LSP may miss it.
import { Text } from "@earendil-works/pi-tui";
import { formatGoalElapsedSeconds, formatTokensCompact, goalStatusLabel } from "./format.js";
import { GOAL_STATUS_VALUES, type GoalStatus, isRecord } from "./types.js";

export type GoalRenderTheme = {
	fg?: (color: string, text: string) => string;
	bold?: (text: string) => string;
};
export type GoalRenderResult = {
	content?: unknown;
	details?: unknown;
	isError?: boolean;
};
export type GoalRenderOptions = {
	expanded?: boolean;
	isPartial?: boolean;
};
export type GoalRenderContext = {
	isError?: boolean;
};

export type GoalToolName = "create_goal" | "get_goal" | "update_goal";

const MAX_OBJECTIVE_LENGTH = 72;
const MAX_ERROR_LENGTH = 96;

function styleTitle(theme: GoalRenderTheme, text: string): string {
	const bold = theme.bold ? theme.bold(text) : text;
	return theme.fg ? theme.fg("toolTitle", bold) : bold;
}

function styleMuted(theme: GoalRenderTheme, text: string): string {
	return theme.fg ? theme.fg("muted", text) : text;
}

function prefixTreeLines(lines: string[]): string[] {
	return lines.map((line, index) => `${index === lines.length - 1 ? "└─" : "├─"} ${line}`);
}

function compactInline(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncateEnd(value: string, maxLength: number): string {
	const chars = Array.from(value);
	if (chars.length <= maxLength) return value;
	if (maxLength <= 1) return "…";
	return `${chars.slice(0, maxLength - 1).join("")}…`;
}

function firstMeaningfulLine(text: string): string {
	return (
		text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? ""
	);
}

function getResultText(result: GoalRenderResult | undefined): string {
	const content = result?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				isRecord(part) && part["type"] === "text" && typeof part["text"] === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

function isGoalStatus(value: unknown): value is GoalStatus {
	return typeof value === "string" && (GOAL_STATUS_VALUES as readonly string[]).includes(value);
}

export function renderGoalCall(
	toolName: GoalToolName,
	rawArgs: Record<string, unknown> | undefined,
	theme: GoalRenderTheme,
): Text {
	const args = isRecord(rawArgs) ? rawArgs : {};
	let suffix = "";
	if (toolName === "create_goal" && typeof args["objective"] === "string") {
		suffix = ` · ${styleMuted(theme, `"${truncateEnd(compactInline(args["objective"]), MAX_OBJECTIVE_LENGTH)}"`)}`;
	} else if (toolName === "update_goal" && typeof args["status"] === "string") {
		suffix = ` · ${styleMuted(theme, args["status"])}`;
	}
	return new Text(`▸ ${styleTitle(theme, toolName)}${suffix}`, 0, 0);
}

function summarizeGoalResult(
	result: GoalRenderResult | undefined,
	text: string,
	options: GoalRenderOptions,
	context: GoalRenderContext,
): string[] {
	if (Boolean(result?.isError) || Boolean(context.isError)) {
		return [`error: ${truncateEnd(firstMeaningfulLine(text) || "unknown error", MAX_ERROR_LENGTH)}`];
	}
	if (options.isPartial) return ["status: running"];

	let goal: unknown;
	try {
		const parsed: unknown = JSON.parse(text);
		goal = isRecord(parsed) ? parsed["goal"] : null;
	} catch {
		return [`goal: ${truncateEnd(firstMeaningfulLine(text) || "no output", MAX_ERROR_LENGTH)}`];
	}
	if (!isRecord(goal)) return ["goal: none set"];

	const objective =
		typeof goal["objective"] === "string" ? truncateEnd(compactInline(goal["objective"]), MAX_OBJECTIVE_LENGTH) : "(unknown)";
	const statusLabel = isGoalStatus(goal["status"]) ? goalStatusLabel(goal["status"]) : String(goal["status"] ?? "unknown");
	const statusParts = [statusLabel];

	const timeUsed = goal["timeUsedSeconds"];
	if (typeof timeUsed === "number" && timeUsed > 0) statusParts.push(formatGoalElapsedSeconds(timeUsed));

	const tokensUsed = typeof goal["tokensUsed"] === "number" ? goal["tokensUsed"] : 0;
	const tokenBudget = goal["tokenBudget"];
	if (tokensUsed > 0 || typeof tokenBudget === "number") {
		const tokenText =
			typeof tokenBudget === "number"
				? `${formatTokensCompact(tokensUsed)}/${formatTokensCompact(tokenBudget)} tokens`
				: `${formatTokensCompact(tokensUsed)} tokens`;
		statusParts.push(tokenText);
	}

	return [`goal: ${objective}`, `status: ${statusParts.join(" · ")}`];
}

export function renderGoalResult(
	result: GoalRenderResult | undefined,
	options: GoalRenderOptions | undefined,
	theme: GoalRenderTheme,
	context: GoalRenderContext | undefined,
): Text {
	const text = getResultText(result);
	if (options?.expanded) return new Text(text, 0, 0);

	const lines = summarizeGoalResult(result, text, options ?? {}, context ?? {});
	lines.push(keyHint("app.tools.expand", "to expand full result"));

	return new Text(
		prefixTreeLines(lines)
			.map((line) => styleMuted(theme, line))
			.join("\n"),
		0,
		0,
	);
}
