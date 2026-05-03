import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { homedir } from "node:os";
import { basename } from "node:path";

const ANSI_ESCAPE_REGEX = /\u001B\[[0-9;]*m/g;

// Status keys to hide from line 3 entirely.
// - thinking-steps: duplicates thinking level already shown on line 2 model segment
// - caveman: noise; user opts in via /caveman
const HIDDEN_STATUS_KEYS = new Set(["thinking-steps", "caveman"]);

// Leading decorative glyphs to strip from status text (e.g. "● Clauderock" -> "Clauderock").
const LEADING_GLYPH_REGEX = /^[\u25CF\u25CB\u2022\u2023\u2219\u26AB\u26AA\u25A0\u25A1\u25AA\u25AB\u2B24]\s*/;

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

// Tokens per second of the most recent completed assistant message.
// Uses entry.timestamp (wall-clock when persisted) to approximate generation duration:
//   duration = assistantEntry.timestamp - prevEntry.timestamp
// The message.timestamp field is set at message *creation* (when agent starts the
// response shell), not completion — so it underreports duration to 1-3ms. Entry
// timestamps are ISO strings written when the entry is appended to the JSONL.
function getLastMessageTps(ctx: Pick<ExtensionContext, "sessionManager">): number | null {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const msg = entry.message as AssistantMessage;
    if (msg.stopReason === "error" || msg.stopReason === "aborted") return null;
    const output = msg.usage.output;
    if (output <= 0) return null;
    // Previous entry (any type) approximates request start.
    if (i === 0) return null;
    const prev = entries[i - 1];
    const endMs = Date.parse((entry as { timestamp: string }).timestamp);
    const startMs = Date.parse((prev as { timestamp: string }).timestamp);
    if (!Number.isFinite(endMs) || !Number.isFinite(startMs)) return null;
    const durationMs = endMs - startMs;
    if (durationMs < 250) return null; // too short, noisy
    return output / (durationMs / 1000);
  }
  return null;
}

function formatTps(tps: number): string {
  if (tps >= 100) return `${Math.round(tps)} tok/s`;
  if (tps >= 10) return `${tps.toFixed(1)} tok/s`;
  return `${tps.toFixed(2)} tok/s`;
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
  const cleaned = sanitizeStatusText(text).replace(LEADING_GLYPH_REGEX, "");
  const statusMatch = cleaned.match(/^([A-Z][A-Z0-9_-]+):\s+(.+?)(?:\s+servers?)?$/);
  if (statusMatch) {
    return `${statusMatch[1]} ${statusMatch[2]}`;
  }
  return cleaned;
}

// Strip leading decorative glyphs from pre-styled status text (preserves ANSI).
function stripLeadingGlyph(styledText: string): string {
  const ansiPrefix = styledText.match(/^(\u001B\[[0-9;]*m)+/)?.[0] ?? "";
  const rest = styledText.slice(ansiPrefix.length);
  const stripped = rest.replace(LEADING_GLYPH_REGEX, "");
  return stripped === rest ? styledText : ansiPrefix + stripped;
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

function getPathLine(
  ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
  branch: string | null,
  theme: ExtensionContext["ui"]["theme"],
): string {
  const sep = theme.fg("dim", " \u00b7 ");
  const parts = [theme.fg("muted", branch ? basename(ctx.cwd) : shortenPath(ctx.cwd))];
  if (branch) parts.push(theme.fg("accent", branch));

  const sessionName = ctx.sessionManager.getSessionName();
  if (sessionName) parts.push(theme.fg("muted", sessionName));

  return parts.join(sep);
}

function getModelSegment(ctx: Pick<ExtensionContext, "model">, thinkingLevel: string): string {
  const modelName = ctx.model?.id ?? "no-model";
  if (!ctx.model?.reasoning) return modelName;
  return `${modelName} · ${thinkingLevel}`;
}

// Labeled token row: "in 10 · out 2.7k · cache 166k/87k"
function formatTokenRow(
  totals: { input: number; output: number; cacheRead: number; cacheWrite: number },
  theme: ExtensionContext["ui"]["theme"],
): string {
  const sep = theme.fg("dim", " · ");
  const segs: string[] = [];
  if (totals.input) {
    segs.push(theme.fg("dim", "in ") + theme.fg("muted", formatTokens(totals.input)));
  }
  if (totals.output) {
    segs.push(theme.fg("dim", "out ") + theme.fg("muted", formatTokens(totals.output)));
  }
  if (totals.cacheRead || totals.cacheWrite) {
    const cacheVal = `${formatTokens(totals.cacheRead)}/${formatTokens(totals.cacheWrite)}`;
    segs.push(theme.fg("dim", "cache ") + theme.fg("muted", cacheVal));
  }
  return segs.join(sep);
}

// Priority-ordered fit: drop lowest-priority segments first when overflowing.
// segments ordered by display order; priorities[i] = drop order (lower = drop first).
function fitSegmentsByPriority(
  segments: string[],
  priorities: number[],
  width: number,
): string {
  const items = segments.map((s, i) => ({ text: s, priority: priorities[i] ?? 0, order: i }));
  const render = () =>
    items
      .filter((x) => x !== null)
      .sort((a, b) => a.order - b.order)
      .map((x) => x.text)
      .join(" · ");

  const active = items.slice();
  let line = active.map((x) => x.text).join(" · ");
  while (active.length > 1 && visibleWidth(line) > width) {
    // drop lowest-priority item (prefer later order on tie)
    let dropIdx = 0;
    for (let i = 1; i < active.length; i++) {
      if (
        active[i].priority < active[dropIdx].priority ||
        (active[i].priority === active[dropIdx].priority && active[i].order > active[dropIdx].order)
      ) {
        dropIdx = i;
      }
    }
    active.splice(dropIdx, 1);
    line = active.sort((a, b) => a.order - b.order).map((x) => x.text).join(" · ");
  }
  return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
}

export function installFooterVisuals(pi: ExtensionAPI): void {
  let currentCtx: ExtensionContext | null = null;

  function installFooter(ctx: ExtensionContext): void {
    currentCtx = ctx;
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

          // Stats segments with priority (higher = keep longer).
          // ctx(4) > model(3) > tps(2) > cost(1)
          const statsSegments: string[] = [];
          const priorities: number[] = [];

          statsSegments.push(getContextSegment(ctx, theme));
          priorities.push(4);

          statsSegments.push(theme.fg("muted", getModelSegment(ctx, pi.getThinkingLevel())));
          priorities.push(3);

          const tps = getLastMessageTps(ctx);
          if (tps !== null) {
            statsSegments.push(theme.fg("dim", formatTps(tps)));
            priorities.push(2);
          }

          if (totals.cost || usingSubscription) {
            statsSegments.push(getCostSegment(totals.cost, usingSubscription, theme));
            priorities.push(1);
          }

          const tokenRight = formatTokenRow(totals, theme);

          const lines = [pathLine];
          const availableLeft = tokenRight
            ? Math.max(10, width - visibleWidth(tokenRight) - 2)
            : width;
          const statsLeft = fitSegmentsByPriority(statsSegments, priorities, availableLeft);

          if (tokenRight) {
            const leftWidth = visibleWidth(statsLeft);
            const rightWidth = visibleWidth(tokenRight);
            const gap = Math.max(2, width - leftWidth - rightWidth);
            lines.push(
              truncateToWidth(
                statsLeft + " ".repeat(gap) + tokenRight,
                width,
                theme.fg("dim", "..."),
              ),
            );
          } else {
            lines.push(statsLeft);
          }

          // Line 3: extension statuses, with hidden keys filtered out.
          const statusEntries = Array.from(footerData.getExtensionStatuses().entries())
            .filter(([key]) => !HIDDEN_STATUS_KEYS.has(key))
            .sort(([a], [b]) => a.localeCompare(b));

          // Infrastructure statuses (MCP, LSP, etc.) go far-right on line 3
          const infraPattern = /^(MCP|LSP)\b/;
          const infraEntries = statusEntries.filter(([, text]) =>
            infraPattern.test(stripAnsi(sanitizeStatusText(text))),
          );
          const infraRight = infraEntries
            .map(([, text]) => theme.fg("muted", simplifyStatusText(text)))
            .join(theme.fg("dim", " \u00b7 "));

          const extraEntries = statusEntries.filter(([, text]) => {
            const cleaned = stripAnsi(sanitizeStatusText(text));
            return cleaned && !infraPattern.test(cleaned);
          });
          if (extraEntries.length > 0 || infraRight) {
            const styledEntries = extraEntries
              .map(([key, text]) => {
                if (key === "agent-mode") return stripLeadingGlyph(text);
                if (key === "clauderock") return stripLeadingGlyph(text);
                return theme.fg("dim", simplifyStatusText(text));
              })
              .filter(Boolean);
            const left = styledEntries.join(theme.fg("dim", " \u00b7 "));
            if (left && infraRight) {
              const leftWidth = visibleWidth(left);
              const rightWidth = visibleWidth(infraRight);
              const gap = Math.max(2, width - leftWidth - rightWidth);
              lines.push(
                truncateToWidth(
                  left + " ".repeat(gap) + infraRight,
                  width,
                  theme.fg("dim", "..."),
                ),
              );
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

  // Print continuation hint when user exits pi (Ctrl+C, Ctrl+D, /quit, SIGHUP, SIGTERM).
  // Skip internal transitions: reload, new, resume, fork.
  pi.on("session_shutdown", async (event, ctx) => {
    const reason = (event as { reason?: string }).reason;
    if (reason && reason !== "quit") return;

    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) return;

    // Defer to next tick so the message lands after TUI teardown.
    setImmediate(() => {
      const cmd = `pi --session ${sessionId}`;
      process.stdout.write(`\nContinue the session with: ${cmd}\n`);
    });
  });

  // Keep currentCtx reference updated (silences unused-var lint if added later).
  void currentCtx;
}
