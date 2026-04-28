import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type ContextUsageSnapshot = {
  tokens: number;
  contextWindow: number;
  percent: number | null;
} | null | undefined;

type CategoryColor = "muted" | "dim" | "warning" | "success" | "accent" | "error" | "borderMuted";

type BreakdownCategory = {
  key: string;
  label: string;
  shortLabel: string;
  color: CategoryColor;
  icon: string;
  tokens: number;
  detail?: string;
};

type Snapshot = {
  modelId: string;
  sessionId: string;
  contextWindow: number;
  usedTokens: number;
  percent: number;
  remainingTokens: number;
  categories: BreakdownCategory[];
  activeToolCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  customMessageCount: number;
  toolCallCount: number;
  toolResultCount: number;
  summaryCount: number;
  branchEntries: number;
};

function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function formatPercent(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

function estimateTokens(text: string): number {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const item of content as any[]) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    if (item.type === "thinking" && typeof item.thinking === "string") parts.push(item.thinking);
    if (item.type === "image" && typeof item.source?.media_type === "string") parts.push(`[image:${item.source.media_type}]`);
  }
  return parts.join("\n");
}

function estimateToolCallPart(part: any): number {
  if (!part || typeof part !== "object") return 0;
  const name = typeof part.name === "string"
    ? part.name
    : typeof part.toolName === "string"
      ? part.toolName
      : "tool";
  const args = part.arguments ?? part.input ?? {};
  return estimateTokens(`${name} ${JSON.stringify(args)}`);
}

function colorizeUsage(theme: any, percent: number, text: string): string {
  if (percent >= 90) return theme.fg("error", text);
  if (percent >= 70) return theme.fg("warning", text);
  return theme.fg("success", text);
}

function allocateScaledValues(rawValues: number[], total: number): number[] {
  if (total <= 0 || rawValues.every((value) => value <= 0)) {
    return rawValues.map(() => 0);
  }

  const rawTotal = rawValues.reduce((sum, value) => sum + value, 0);
  if (rawTotal <= 0) {
    return rawValues.map(() => 0);
  }

  const quotas = rawValues.map((value) => (value / rawTotal) * total);
  const base = quotas.map((quota) => Math.floor(quota));
  let remaining = total - base.reduce((sum, value) => sum + value, 0);

  const remainders = quotas
    .map((quota, index) => ({ index, remainder: quota - Math.floor(quota), raw: rawValues[index] ?? 0 }))
    .sort((a, b) => {
      if (b.remainder !== a.remainder) return b.remainder - a.remainder;
      return b.raw - a.raw;
    });

  for (const item of remainders) {
    if (remaining <= 0) break;
    if ((rawValues[item.index] ?? 0) <= 0) continue;
    base[item.index] += 1;
    remaining -= 1;
  }

  for (let index = 0; index < rawValues.length; index += 1) {
    if (remaining <= 0) break;
    if ((rawValues[index] ?? 0) <= 0) continue;
    base[index] += 1;
    remaining -= 1;
  }

  return base;
}

function buildSnapshot(ctx: ExtensionCommandContext, pi: ExtensionAPI): Snapshot | null {
  const usage = ctx.getContextUsage() as ContextUsageSnapshot;
  if (!usage || typeof usage.tokens !== "number" || typeof usage.contextWindow !== "number" || usage.contextWindow <= 0) {
    return null;
  }

  const branch = ctx.sessionManager.getBranch() as any[];
  const activeToolNames = new Set(pi.getActiveTools());
  const activeToolDefs = pi.getAllTools().filter((tool) => activeToolNames.has(tool.name));
  const systemPrompt = ctx.getSystemPrompt();

  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let customMessageCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let summaryCount = 0;

  let userAssistantRaw = 0;
  let toolCallRaw = 0;
  let toolResultRaw = 0;
  let summaryRaw = 0;

  for (const entry of branch) {
    if (!entry || typeof entry !== "object") continue;

    if (entry.type === "message") {
      const message = entry.message;
      if (!message || typeof message !== "object") continue;

      if (message.role === "user") {
        userMessageCount += 1;
        userAssistantRaw += estimateTokens(extractTextContent(message.content));
        continue;
      }

      if (message.role === "assistant") {
        assistantMessageCount += 1;
        if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (!part || typeof part !== "object") continue;
            if (part.type === "toolCall") {
              toolCallCount += 1;
              toolCallRaw += estimateToolCallPart(part);
            } else if (part.type === "text" || part.type === "thinking") {
              userAssistantRaw += estimateTokens(typeof (part as any).text === "string"
                ? (part as any).text
                : typeof (part as any).thinking === "string"
                  ? (part as any).thinking
                  : "");
            }
          }
        } else {
          userAssistantRaw += estimateTokens(extractTextContent(message.content));
        }
        continue;
      }

      if (message.role === "toolResult") {
        toolResultCount += 1;
        toolResultRaw += estimateTokens(extractTextContent(message.content));
        continue;
      }

      if (message.role === "bashExecution") {
        if (message.excludeFromContext) continue;
        toolCallCount += 1;
        toolResultCount += 1;
        toolCallRaw += estimateTokens(String(message.command ?? ""));
        toolResultRaw += estimateTokens(String(message.output ?? ""));
        continue;
      }

      if (message.role === "custom") {
        customMessageCount += 1;
        userAssistantRaw += estimateTokens(extractTextContent(message.content));
      }

      continue;
    }

    if (entry.type === "custom_message") {
      customMessageCount += 1;
      userAssistantRaw += estimateTokens(extractTextContent(entry.content));
      continue;
    }

    if (entry.type === "compaction" || entry.type === "branch_summary") {
      summaryCount += 1;
      summaryRaw += estimateTokens(String(entry.summary ?? ""));
    }
  }

  const systemPromptRaw = estimateTokens(systemPrompt);
  const systemToolsRaw = estimateTokens(JSON.stringify(activeToolDefs));

  const rawCategories = [
    { key: "system-prompt", label: "System Prompt", shortLabel: "Prompt", color: "muted" as const, icon: "■", raw: systemPromptRaw, detail: `${systemPrompt.length.toLocaleString()} chars` },
    { key: "system-tools", label: "System Tools", shortLabel: "Tools", color: "dim" as const, icon: "■", raw: systemToolsRaw, detail: `${activeToolDefs.length} active` },
    { key: "tool-calls", label: "Tool Calls", shortLabel: "Calls", color: "warning" as const, icon: "■", raw: toolCallRaw, detail: `${toolCallCount} calls` },
    { key: "tool-results", label: "Tool Results", shortLabel: "Results", color: "success" as const, icon: "■", raw: toolResultRaw, detail: `${toolResultCount} results` },
    { key: "messages", label: "Messages", shortLabel: "Msgs", color: "accent" as const, icon: "■", raw: userAssistantRaw, detail: `${userMessageCount + assistantMessageCount + customMessageCount} msgs` },
    { key: "summaries", label: "Summaries", shortLabel: "Summ", color: "error" as const, icon: "■", raw: summaryRaw, detail: `${summaryCount} summaries` },
  ];

  const scaled = allocateScaledValues(rawCategories.map((category) => category.raw), usage.tokens);
  const categories: BreakdownCategory[] = rawCategories.map((category, index) => ({
    key: category.key,
    label: category.label,
    shortLabel: category.shortLabel,
    color: category.color,
    icon: category.icon,
    tokens: scaled[index] ?? 0,
    detail: category.detail,
  }));

  const categorizedTokens = categories.reduce((sum, category) => sum + category.tokens, 0);
  const uncategorized = Math.max(0, usage.tokens - categorizedTokens);
  if (uncategorized > 0) {
    categories.push({
      key: "other",
      label: "Other",
      shortLabel: "Other",
      color: "dim",
      icon: "■",
      tokens: uncategorized,
      detail: "runtime overhead",
    });
  }

  categories.push({
    key: "available",
    label: "Available",
    shortLabel: "Avail",
    color: "borderMuted",
    icon: "□",
    tokens: Math.max(0, usage.contextWindow - usage.tokens),
    detail: `${formatTokens(Math.max(0, usage.contextWindow - usage.tokens))} left`,
  });

  return {
    modelId: ctx.model?.id ?? "unknown",
    sessionId: ctx.sessionManager.getSessionId().slice(0, 8),
    contextWindow: usage.contextWindow,
    usedTokens: usage.tokens,
    percent: typeof usage.percent === "number" ? usage.percent : (usage.tokens / usage.contextWindow) * 100,
    remainingTokens: Math.max(0, usage.contextWindow - usage.tokens),
    categories,
    activeToolCount: activeToolDefs.length,
    userMessageCount,
    assistantMessageCount,
    customMessageCount,
    toolCallCount,
    toolResultCount,
    summaryCount,
    branchEntries: branch.length,
  };
}

function buildDetailLines(snapshot: Snapshot, theme: any, width: number): string[] {
  const valueWidth = 7;
  const percentWidth = 6;
  const labelWidth = width >= 96 ? 14 : 12;
  const showDetail = width >= 88;

  const totalLine = `${theme.fg("text", theme.bold("Total Usage".padEnd(labelWidth + 2)))} ${theme.fg("text", theme.bold(formatTokens(snapshot.usedTokens).padStart(valueWidth)))} ${theme.fg("text", theme.bold(`(${formatPercent(snapshot.percent).padStart(percentWidth)})`))}`;
  const lines = [totalLine, ""];

  for (const category of snapshot.categories) {
    const pct = ((category.tokens / snapshot.contextWindow) * 100);
    const label = category.label.padEnd(labelWidth);
    const value = formatTokens(category.tokens).padStart(valueWidth);
    const detail = showDetail && category.detail ? ` ${theme.fg("dim", `· ${category.detail}`)}` : "";
    lines.push(
      `${theme.fg(category.color, category.icon)} ${theme.fg("text", label)} ${theme.fg("accent", value)} (${formatPercent(pct).padStart(percentWidth)})${detail}`,
    );
  }

  lines.push("");
  lines.push(theme.fg("dim", `model ${snapshot.modelId} · session ${snapshot.sessionId} · window ${formatTokens(snapshot.contextWindow)}`));
  lines.push(theme.fg("dim", `tools ${snapshot.activeToolCount} · user ${snapshot.userMessageCount} · asst ${snapshot.assistantMessageCount} · custom ${snapshot.customMessageCount}`));
  lines.push(theme.fg("dim", `calls ${snapshot.toolCallCount} · results ${snapshot.toolResultCount} · summaries ${snapshot.summaryCount} · entries ${snapshot.branchEntries}`));

  return lines;
}

function buildGridLines(snapshot: Snapshot, theme: any): string[] {
  const usedCategories = snapshot.categories.filter((category) => category.key !== "available");
  const totalBlocks = 50;
  const gridWidth = 10;
  const gridHeight = 5;
  const usedBlocks = Math.max(0, Math.min(totalBlocks, Math.round((snapshot.usedTokens / snapshot.contextWindow) * totalBlocks)));
  const blockCounts = allocateScaledValues(usedCategories.map((category) => category.tokens), usedBlocks);

  const blocks: Array<{ color: CategoryColor; filled: boolean }> = [];
  usedCategories.forEach((category, index) => {
    const count = blockCounts[index] ?? 0;
    for (let block = 0; block < count && blocks.length < totalBlocks; block += 1) {
      blocks.push({ color: category.color, filled: true });
    }
  });
  while (blocks.length < totalBlocks) {
    blocks.push({ color: "borderMuted", filled: false });
  }

  const lines: string[] = [];
  for (let row = 0; row < gridHeight; row += 1) {
    let line = "";
    for (let column = 0; column < gridWidth; column += 1) {
      const block = blocks[row * gridWidth + column]!;
      line += theme.fg(block.color, block.filled ? "■ " : "□ ");
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function joinSideBySide(leftLines: string[], rightLines: string[], leftWidth: number, gap: string): string[] {
  const maxLines = Math.max(leftLines.length, rightLines.length);
  const lines: string[] = [];

  for (let index = 0; index < maxLines; index += 1) {
    const left = leftLines[index] ?? "";
    const leftPad = Math.max(0, leftWidth - visibleWidth(left));
    const right = rightLines[index] ?? "";
    lines.push(left + " ".repeat(leftPad) + gap + right);
  }

  return lines;
}

function buildWidgetLines(snapshot: Snapshot, theme: any, width: number): string[] {
  if (width < 24) return [];

  const innerWidth = Math.max(1, width - 4);
  const lines: string[] = [];
  const title = theme.bold(theme.fg("accent", "Context Usage"));
  const summaryLine = colorizeUsage(
    theme,
    snapshot.percent,
    `${formatTokens(snapshot.usedTokens)} / ${formatTokens(snapshot.contextWindow)} (${formatPercent(snapshot.percent)})`,
  );

  const row = (content: string) => {
    const clipped = truncateToWidth(content, innerWidth, "");
    const pad = Math.max(0, innerWidth - visibleWidth(clipped));
    return `${theme.fg("border", "│")} ${clipped}${" ".repeat(pad)} ${theme.fg("border", "│")}`;
  };

  lines.push(theme.fg("border", `╭${"─".repeat(width - 2)}╮`));
  lines.push(row(title));
  lines.push(row(""));

  const gridLines = buildGridLines(snapshot, theme);
  const detailLines = buildDetailLines(snapshot, theme, innerWidth);

  if (innerWidth >= 84) {
    const combined = joinSideBySide(gridLines, detailLines, 20, "    ");
    for (const line of combined) lines.push(row(line));
  } else {
    lines.push(row(summaryLine));
    lines.push(row(""));
    for (const line of gridLines) lines.push(row(line));
    lines.push(row(""));
    for (const line of detailLines) lines.push(row(line));
  }

  lines.push(theme.fg("border", `╰${"─".repeat(width - 2)}╯`));
  return lines;
}

function buildPlainText(snapshot: Snapshot): string {
  const lines: string[] = [];
  lines.push("Context Usage");
  lines.push(`total: ${formatTokens(snapshot.usedTokens)} / ${formatTokens(snapshot.contextWindow)} (${formatPercent(snapshot.percent)})`);
  lines.push(`remaining: ${formatTokens(snapshot.remainingTokens)}`);
  lines.push(`model: ${snapshot.modelId}`);
  lines.push(`session: ${snapshot.sessionId}`);
  lines.push(`tools: ${snapshot.activeToolCount} · user: ${snapshot.userMessageCount} · assistant: ${snapshot.assistantMessageCount} · custom: ${snapshot.customMessageCount}`);
  lines.push(`calls: ${snapshot.toolCallCount} · results: ${snapshot.toolResultCount} · summaries: ${snapshot.summaryCount} · entries: ${snapshot.branchEntries}`);
  lines.push("");

  for (const category of snapshot.categories) {
    const pct = (category.tokens / snapshot.contextWindow) * 100;
    const detail = category.detail ? ` · ${category.detail}` : "";
    lines.push(`${category.icon} ${category.label}: ${formatTokens(category.tokens)} (${formatPercent(pct)})${detail}`);
  }

  return lines.join("\n");
}

export default function contextExtension(pi: ExtensionAPI): void {
  pi.registerCommand("context", {
    description: "Visualize detailed current session context usage",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const snapshot = buildSnapshot(ctx, pi);
      if (!snapshot) {
        if (ctx.hasUI) ctx.ui.notify("Context usage info not available.", "warning");
        else console.log("Context usage info not available.");
        return;
      }

      if (!ctx.hasUI) {
        console.log(buildPlainText(snapshot));
        return;
      }

      await ctx.ui.custom((_tui, theme, _kb, done) => ({
        invalidate() {},
        handleInput(data: string) {
          if (matchesKey(data, "ctrl+c")) return;
          done(undefined);
        },
        render(width: number): string[] {
          return buildWidgetLines(snapshot, theme, width);
        },
      }), { overlay: true });
    },
  });
}
