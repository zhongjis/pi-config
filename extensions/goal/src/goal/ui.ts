import type { ExtensionContext, ReadonlyFooterDataProvider, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { formatGoalElapsedSeconds, formatTokensCompact } from "./format.js";
import type { Goal, GoalStatus } from "./types.js";
import { isRecord } from "./types.js";

export const STATUS_KEY = "goal";
const LEGACY_WIDGET_KEY = "goal";
let goalFooterInstalled = false;

type GoalFooterIndicator = {
	text: string;
	color: ThemeColor;
};

type FooterTokenStats = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costTotal: number;
};

type FooterAssistantMessage = {
	role: "assistant";
	usage: Record<string, unknown>;
};

// Cross-extension footer integration.
// Only one footer can occupy the single ctx.ui.setFooter() slot at a time. When the
// `qol` extension is loaded it owns that slot; instead of installing our own footer
// (which would clobber the qol footer, and whose teardown would restore the built-in
// footer rather than the qol one), we publish the current goal indicator on a
// Symbol.for() global bridge that qol reads and renders. We fall back to the
// standalone Codex footer when qol is absent.
const GOAL_FOOTER_BRIDGE_KEY = Symbol.for("pi-goal:footer");
const VISUALS_FOOTER_OWNER_KEY = Symbol.for("pi-visuals:footer");

type GoalFooterBridge = {
	getIndicator(isIdle: boolean): GoalFooterIndicator | null;
};

type GoalPresentationObservation = {
	goal: Goal;
	elapsedMilliseconds: number;
	observedAtMilliseconds: number;
};

let currentGoalObservation: GoalPresentationObservation | null = null;

function materializeGoalForPresentation(isIdle: boolean, now = Date.now()): Goal | null {
	const observation = currentGoalObservation;
	if (observation === null) return null;

	if (observation.goal.status === "active" && !isIdle) {
		observation.elapsedMilliseconds += Math.max(0, now - observation.observedAtMilliseconds);
	}
	observation.observedAtMilliseconds = now;

	return {
		...observation.goal,
		timeUsedSeconds: Math.max(
			observation.goal.timeUsedSeconds,
			Math.round(observation.elapsedMilliseconds / 1000),
		),
	};
}

function observeGoalForPresentation(goal: Goal | null, isIdle: boolean): void {
	const now = Date.now();
	materializeGoalForPresentation(isIdle, now);
	if (goal === null) {
		currentGoalObservation = null;
		return;
	}

	const persistedElapsedMilliseconds = Math.max(0, goal.timeUsedSeconds * 1000);
	const elapsedMilliseconds =
		currentGoalObservation?.goal.id === goal.id
			? Math.max(currentGoalObservation.elapsedMilliseconds, persistedElapsedMilliseconds)
			: persistedElapsedMilliseconds;
	currentGoalObservation = {
		goal: { ...goal },
		elapsedMilliseconds,
		observedAtMilliseconds: now,
	};
}

function currentGoalIndicator(isIdle: boolean): GoalFooterIndicator | null {
	const goal = materializeGoalForPresentation(isIdle);
	return goal === null ? null : goalFooterIndicator(goal);
}

function publishGoalFooterBridge(): void {
	const bridge: GoalFooterBridge = {
		getIndicator: currentGoalIndicator,
	};
	(globalThis as Record<symbol, unknown>)[GOAL_FOOTER_BRIDGE_KEY] = bridge;
}

function visualsOwnsFooter(): boolean {
	return Boolean((globalThis as Record<symbol, unknown>)[VISUALS_FOOTER_OWNER_KEY]);
}

export function updateGoalUi(ctx: ExtensionContext, goal: Goal | null): void {
	if (!ctx.hasUI) return;

	ctx.ui.setWidget(LEGACY_WIDGET_KEY, undefined);
	ctx.ui.setStatus(STATUS_KEY, undefined);

	observeGoalForPresentation(goal, ctx.isIdle());
	publishGoalFooterBridge();

	// When the qol extension owns the single footer slot it renders the goal
	// indicator from the bridge published above. The setStatus() call already requested a
	// re-render, so avoid installing our own footer (which would clobber the qol one).
	if (visualsOwnsFooter()) return;

	if (!goal) {
		if (goalFooterInstalled) {
			ctx.ui.setFooter(undefined);
			goalFooterInstalled = false;
		}
		return;
	}

	goalFooterInstalled = true;
	ctx.ui.setFooter((_tui, theme, footerData) => new GoalFooterComponent(ctx, footerData, theme));
}

export function goalFooterIndicator(goal: Goal): GoalFooterIndicator {
	const usageText = goalStatusUsage(goal);
	const color = goalStatusColor(goal.status);
	switch (goal.status) {
		case "active":
			return { color, text: usageText === null ? "Pursuing goal" : `Pursuing goal (${usageText})` };
		case "paused":
			return { color, text: "Goal paused (/goal resume)" };
		case "blocked":
			return { color, text: "Goal blocked (/goal resume)" };
		case "budgetLimited":
			return { color, text: usageText === null ? "Goal abandoned" : `Goal unmet (${usageText})` };
		case "complete":
			return { color, text: usageText === null ? "Goal achieved" : `Goal achieved (${usageText})` };
	}
}

export function composeFooterStatusLine(leftText: string, rightText: string, width: number): string {
	if (width <= 0) return "";

	const sanitizedLeftText = sanitizeStatusText(leftText);
	const rightTextWidth = visibleWidth(rightText);
	if (sanitizedLeftText.length === 0) {
		return rightAlignFooterText(rightText, width, rightTextWidth);
	}

	const leftTextWidth = visibleWidth(sanitizedLeftText);
	if (leftTextWidth + 2 + rightTextWidth <= width) {
		return `${sanitizedLeftText}${" ".repeat(width - leftTextWidth - rightTextWidth)}${rightText}`;
	}

	if (rightTextWidth <= width) {
		return rightAlignFooterText(rightText, width, rightTextWidth);
	}

	return truncateToWidth(rightText, width, "");
}

class GoalFooterComponent implements Component {
	constructor(
		private readonly ctx: ExtensionContext,
		private readonly footerData: ReadonlyFooterDataProvider,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		const goal = materializeGoalForPresentation(this.ctx.isIdle());
		if (goal === null) return [this.workingDirectoryLine(width), this.statsLine(width)];
		return [this.workingDirectoryLine(width), this.statsLine(width), this.goalStatusLine(goal, width)];
	}

	invalidate(): void {}

	private workingDirectoryLine(width: number): string {
		let workingDirectory = this.ctx.sessionManager.getCwd();
		const homeDirectory = process.env["HOME"] ?? process.env["USERPROFILE"];
		if (homeDirectory !== undefined && workingDirectory.startsWith(homeDirectory)) {
			workingDirectory = `~${workingDirectory.slice(homeDirectory.length)}`;
		}

		const branch = this.footerData.getGitBranch();
		if (branch !== null) {
			workingDirectory = `${workingDirectory} (${branch})`;
		}

		const sessionName = this.ctx.sessionManager.getSessionName();
		if (sessionName !== undefined) {
			workingDirectory = `${workingDirectory} • ${sessionName}`;
		}

		return truncateToWidth(this.theme.fg("dim", workingDirectory), width, this.theme.fg("dim", "..."));
	}

	private statsLine(width: number): string {
		const tokenStats = collectFooterTokenStats(this.ctx);
		const statsParts = footerStatsParts(this.ctx, tokenStats, this.theme);
		let statsLeft = statsParts.join(" ");
		let statsLeftWidth = visibleWidth(statsLeft);
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		const rightSide = footerRightSide(this.ctx, this.footerData);
		const rightSideWidth = visibleWidth(rightSide);
		const minimumPadding = 2;
		const totalNeededWidth = statsLeftWidth + minimumPadding + rightSideWidth;
		const statsLine =
			totalNeededWidth <= width
				? `${statsLeft}${" ".repeat(width - statsLeftWidth - rightSideWidth)}${rightSide}`
				: compactStatsLine(statsLeft, statsLeftWidth, rightSide, width);

		const dimStatsLeft = this.theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length);
		return `${dimStatsLeft}${this.theme.fg("dim", remainder)}`;
	}

	private goalStatusLine(goal: Goal, width: number): string {
		const indicator = goalFooterIndicator(goal);
		const rightText = this.theme.fg(indicator.color, indicator.text);
		const leftText = Array.from(this.footerData.getExtensionStatuses().entries())
			.filter(([key]) => key !== STATUS_KEY)
			.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
			.map(([, text]) => text)
			.join(" ");

		return truncateToWidth(composeFooterStatusLine(leftText, rightText, width), width, this.theme.fg("dim", "..."));
	}
}

function goalStatusUsage(goal: Goal): string | null {
	switch (goal.status) {
		case "active":
			return goal.tokenBudget === undefined
				? formatGoalElapsedSeconds(goal.timeUsedSeconds)
				: `${formatTokensCompact(goal.tokensUsed)} / ${formatTokensCompact(goal.tokenBudget)}`;
		case "paused":
			return null;
		case "blocked":
			return null;
		case "budgetLimited":
			return goal.tokenBudget === undefined
				? null
				: `${formatTokensCompact(goal.tokensUsed)} / ${formatTokensCompact(goal.tokenBudget)} tokens`;
		case "complete":
			return goal.tokenBudget === undefined
				? formatGoalElapsedSeconds(goal.timeUsedSeconds)
				: `${formatTokensCompact(goal.tokensUsed)} tokens`;
	}
}

function goalStatusColor(status: GoalStatus): ThemeColor {
	switch (status) {
		case "active":
			return "accent";
		case "paused":
			return "muted";
		case "blocked":
			return "warning";
		case "budgetLimited":
			return "warning";
		case "complete":
			return "success";
	}
}

function rightAlignFooterText(text: string, width: number, textWidth: number): string {
	if (textWidth >= width) return truncateToWidth(text, width, "");
	return `${" ".repeat(width - textWidth)}${text}`;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function collectFooterTokenStats(ctx: ExtensionContext): FooterTokenStats {
	const stats: FooterTokenStats = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		costTotal: 0,
	};

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || !isFooterAssistantMessage(entry.message)) continue;
		stats.input += numericUsageField(entry.message.usage, "input");
		stats.output += numericUsageField(entry.message.usage, "output");
		stats.cacheRead += numericUsageField(entry.message.usage, "cacheRead");
		stats.cacheWrite += numericUsageField(entry.message.usage, "cacheWrite");
		stats.costTotal += nestedNumericUsageField(entry.message.usage, "cost", "total");
	}

	return stats;
}

function isFooterAssistantMessage(message: unknown): message is FooterAssistantMessage {
	return isRecord(message) && message["role"] === "assistant" && isRecord(message["usage"]);
}

function footerStatsParts(ctx: ExtensionContext, tokenStats: FooterTokenStats, theme: Theme): string[] {
	const parts: string[] = [];
	if (tokenStats.input !== 0) parts.push(`↑${formatFooterTokens(tokenStats.input)}`);
	if (tokenStats.output !== 0) parts.push(`↓${formatFooterTokens(tokenStats.output)}`);
	if (tokenStats.cacheRead !== 0) parts.push(`R${formatFooterTokens(tokenStats.cacheRead)}`);
	if (tokenStats.cacheWrite !== 0) parts.push(`W${formatFooterTokens(tokenStats.cacheWrite)}`);

	const usingSubscription = ctx.model === undefined ? false : ctx.modelRegistry.isUsingOAuth(ctx.model);
	if (tokenStats.costTotal !== 0 || usingSubscription) {
		parts.push(`$${tokenStats.costTotal.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
	}

	parts.push(contextUsageText(ctx, theme));
	return parts;
}

function contextUsageText(ctx: ExtensionContext, theme: Theme): string {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const contextPercentValue = usage?.percent ?? 0;
	const autoIndicator = " (auto)";
	const contextPercentDisplay =
		usage?.percent === null || usage?.percent === undefined
			? `?/${formatFooterTokens(contextWindow)}${autoIndicator}`
			: `${usage.percent.toFixed(1)}%/${formatFooterTokens(contextWindow)}${autoIndicator}`;

	if (contextPercentValue > 90) return theme.fg("error", contextPercentDisplay);
	if (contextPercentValue > 70) return theme.fg("warning", contextPercentDisplay);
	return contextPercentDisplay;
}

function footerRightSide(ctx: ExtensionContext, footerData: ReadonlyFooterDataProvider): string {
	const model = ctx.model;
	const modelName = model?.id ?? "no-model";
	const thinkingLevel = currentThinkingLevel(ctx) ?? "off";
	const rightSideWithoutProvider =
		model?.reasoning !== true
			? modelName
			: thinkingLevel === "off"
				? `${modelName} • thinking off`
				: `${modelName} • ${thinkingLevel}`;

	if (model === undefined || footerData.getAvailableProviderCount() <= 1) return rightSideWithoutProvider;

	const rightSideWithProvider = `(${model.provider}) ${rightSideWithoutProvider}`;
	return rightSideWithProvider;
}

function compactStatsLine(statsLeft: string, statsLeftWidth: number, rightSide: string, width: number): string {
	const minimumPadding = 2;
	const availableForRightSide = width - statsLeftWidth - minimumPadding;
	if (availableForRightSide <= 0) return statsLeft;

	const truncatedRightSide = truncateToWidth(rightSide, availableForRightSide, "");
	const padding = " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRightSide)));
	return `${statsLeft}${padding}${truncatedRightSide}`;
}

function currentThinkingLevel(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type === "thinking_level_change") return entry.thinkingLevel;
	}
	return undefined;
}

function formatFooterTokens(count: number): string {
	if (count < 1_000) return count.toString();
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function numericUsageField(usage: Record<string, unknown>, key: string): number {
	const value = usage[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nestedNumericUsageField(usage: Record<string, unknown>, outerKey: string, innerKey: string): number {
	const outerValue = usage[outerKey];
	if (!isRecord(outerValue)) return 0;
	return numericUsageField(outerValue, innerKey);
}
