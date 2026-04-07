import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { homedir } from "node:os";

const ANSI_ESCAPE_REGEX = /\u001B\[[0-9;]*m/g;

function shortenPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_REGEX, "");
}

function sanitizeStatusText(text: string): string {
  return stripAnsi(text)
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function simplifyStatusText(text: string): string {
  const cleaned = sanitizeStatusText(text);
  const statusMatch = cleaned.match(/^([A-Z][A-Z0-9_-]+):\s+(.+?)(?:\s+servers?)?$/);
  if (statusMatch) {
    return `${statusMatch[1]} ${statusMatch[2]}`;
  }
  return cleaned;
}

function getUsageTotals(ctx: Pick<ExtensionContext, "sessionManager">): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
} {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;

    const message = entry.message as AssistantMessage;
    input += message.usage.input;
    output += message.usage.output;
    cacheRead += message.usage.cacheRead;
    cacheWrite += message.usage.cacheWrite;
    cost += message.usage.cost.total;
  }

  return { input, output, cacheRead, cacheWrite, cost };
}

function getContextSegment(ctx: ExtensionContext, theme: ExtensionContext["ui"]["theme"]): string {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const percentValue = usage?.percent ?? 0;
  const percent = usage?.percent === null ? "?" : usage?.percent.toFixed(1);
  const text = `ctx ${percent}%/${formatTokens(contextWindow)}`;

  if (percentValue > 90) return theme.fg("error", text);
  if (percentValue > 70) return theme.fg("warning", text);
  return theme.fg("muted", text);
}

function getCostSegment(
  cost: number,
  usingSubscription: boolean,
  theme: ExtensionContext["ui"]["theme"],
): string {
  const costText = `$${cost.toFixed(3)}`;
  const label = usingSubscription ? `${costText} sub` : costText;

  if (cost >= 10) return theme.fg("error", label);
  if (cost >= 1) return theme.fg("warning", label);
  return theme.fg("dim", label);
}

function getPathLine(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, branch: string | null): string {
  const parts = [shortenPath(ctx.cwd)];
  if (branch) parts.push(branch);

  const sessionName = ctx.sessionManager.getSessionName();
  if (sessionName) parts.push(sessionName);

  parts.push(ctx.sessionManager.getSessionId().slice(0, 8));

  return parts.join(" · ");
}

function getModelSegment(ctx: Pick<ExtensionContext, "model">, thinkingLevel: string): string {
  const modelName = ctx.model?.id ?? "no-model";
  if (!ctx.model?.reasoning) return modelName;
  return `${modelName} · ${thinkingLevel}`;
}

function fitSegments(segments: string[], width: number): string {
  const visibleSegments = [...segments];
  let line = visibleSegments.join(" · ");

  while (visibleSegments.length > 1 && visibleWidth(line) > width) {
    visibleSegments.splice(visibleSegments.length - 2, 1);
    line = visibleSegments.join(" · ");
  }

  return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
}

export default function (pi: ExtensionAPI) {
  function installFooter(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose() {
          unsubscribe();
        },
        invalidate() {},
        render(width: number): string[] {
          const branch = footerData.getGitBranch();
          const pathLine = truncateToWidth(
            theme.fg("dim", getPathLine(ctx, branch)),
            width,
            theme.fg("dim", "..."),
          );

          const totals = getUsageTotals(ctx);
          const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;

          const statsSegments = [
            getContextSegment(ctx, theme),
            theme.fg("dim", getModelSegment(ctx, pi.getThinkingLevel())),
          ];

          if (totals.cost || usingSubscription) {
            statsSegments.push(getCostSegment(totals.cost, usingSubscription, theme));
          }
          if (totals.input || totals.output) {
            statsSegments.push(theme.fg("dim", `↑${formatTokens(totals.input)} ↓${formatTokens(totals.output)}`));
          }
          if (totals.cacheRead) {
            statsSegments.push(theme.fg("dim", `R${formatTokens(totals.cacheRead)}`));
          }
          if (totals.cacheWrite) {
            statsSegments.push(theme.fg("dim", `W${formatTokens(totals.cacheWrite)}`));
          }

          const statuses = Array.from(footerData.getExtensionStatuses().entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => simplifyStatusText(text))
            .filter(Boolean);

          const mcpStatus = statuses.find((status) => /^MCP\b/.test(status));
          if (mcpStatus) {
            statsSegments.push(theme.fg("dim", mcpStatus));
          }

          const lines = [pathLine, fitSegments(statsSegments, width)];
          const extraStatuses = statuses.filter((status) => status !== mcpStatus);
          if (extraStatuses.length > 0) {
            const statusLine = extraStatuses.join(theme.fg("dim", " · "));

            lines.push(truncateToWidth(theme.fg("dim", statusLine), width, theme.fg("dim", "...")));
          }

          return lines;
        },
      };
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    installFooter(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    installFooter(ctx);
  });
}
