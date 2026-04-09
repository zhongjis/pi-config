import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { homedir } from "node:os";
import { basename } from "node:path";

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
  const label = usingSubscription ? `${costText} (sub)` : costText;

  if (cost >= 10) return theme.fg("error", label);
  if (cost >= 1) return theme.fg("warning", label);
  return theme.fg("dim", label);
}

function getPathLine(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, branch: string | null, theme: ExtensionContext["ui"]["theme"]): string {
  const sep = theme.fg("dim", " \u00b7 ");
  const parts = [theme.fg("muted", branch ? basename(ctx.cwd) : shortenPath(ctx.cwd))];
  if (branch) parts.push(theme.fg("accent", branch));

  const sessionName = ctx.sessionManager.getSessionName();
  if (sessionName) parts.push(theme.fg("muted", sessionName));

  const main = parts.join(sep);
  const sessionId = ctx.sessionManager.getSessionId().slice(0, 8);
  return `${main} ${theme.fg("dim", sessionId)}`;
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
            getPathLine(ctx, branch, theme),
            width,
            theme.fg("dim", "..."),
          );

          const totals = getUsageTotals(ctx);
          const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;

          const statsSegments = [
            getContextSegment(ctx, theme),
            theme.fg("muted", getModelSegment(ctx, pi.getThinkingLevel())),
          ];

          if (totals.cost || usingSubscription) {
            statsSegments.push(getCostSegment(totals.cost, usingSubscription, theme));
          }
          let tokenRight = "";
          if (totals.input || totals.output) {
            let tokenParts = theme.fg("success", "\u2191") + theme.fg("dim", formatTokens(totals.input));
            tokenParts += " " + theme.fg("muted", "\u2193") + theme.fg("dim", formatTokens(totals.output));
            if (totals.cacheRead) tokenParts += theme.fg("dim", ` cR${formatTokens(totals.cacheRead)}`);
            if (totals.cacheWrite) tokenParts += theme.fg("dim", ` cW${formatTokens(totals.cacheWrite)}`);
            tokenRight = tokenParts;
          }

          const lines = [pathLine];
          const statsLeft = fitSegments(statsSegments, width);
          if (tokenRight) {
            const leftWidth = visibleWidth(statsLeft);
            const rightWidth = visibleWidth(tokenRight);
            const gap = Math.max(2, width - leftWidth - rightWidth);
            lines.push(truncateToWidth(statsLeft + " ".repeat(gap) + tokenRight, width, theme.fg("dim", "...")));
          } else {
            lines.push(statsLeft);
          }

          const statusEntries = Array.from(footerData.getExtensionStatuses().entries())
            .sort(([a], [b]) => a.localeCompare(b));
          const statuses = statusEntries
            .map(([key, text]) => key === "agent-mode" ? text : simplifyStatusText(text))
            .filter(Boolean);

          // Infrastructure statuses (MCP, LSP, etc.) go far-right on line 3
          const infraPattern = /^(MCP|LSP)\b/;
          const infraStatuses = statuses.filter((s) => infraPattern.test(stripAnsi(s)));
          const infraRight = infraStatuses.map((s) => theme.fg("muted", s)).join(theme.fg("dim", " \u00b7 "));

          const extraEntries = statusEntries.filter(([, text]) => {
            const cleaned = simplifyStatusText(text);
            return cleaned && !infraPattern.test(cleaned);
          });
          if (extraEntries.length > 0 || infraRight) {
            const styledEntries = extraEntries.map(([key, text]) =>
              key === "agent-mode" ? text : theme.fg("dim", simplifyStatusText(text))
            ).filter(Boolean);
            const left = styledEntries.join(theme.fg("dim", " \u00b7 "));
            if (left && infraRight) {
              const leftWidth = visibleWidth(left);
              const rightWidth = visibleWidth(infraRight);
              const gap = Math.max(2, width - leftWidth - rightWidth);
              lines.push(truncateToWidth(left + " ".repeat(gap) + infraRight, width, theme.fg("dim", "...")));
            } else if (left) {
              lines.push(truncateToWidth(left, width, theme.fg("dim", "...")));
            } else if (infraRight) {
              const pad = Math.max(0, width - visibleWidth(infraRight));
              lines.push(" ".repeat(pad) + infraRight);
            }
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
