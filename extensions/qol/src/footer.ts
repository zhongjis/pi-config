import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";

const ANSI_ESCAPE_REGEX = /\u001B\[[0-9;]*m/g;

// Status keys to hide from the status line entirely.
// - thinking-steps: duplicates thinking level already shown in the stats-line model segment
// - caveman: noise; user opts in via /caveman
const HIDDEN_STATUS_KEYS = new Set(["thinking-steps", "caveman", "fast"]);

// Leading decorative glyphs to strip from status text.
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

// Format the most recent completed assistant message's generation rate.
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

// Subagent cost is owned by the `extensions/subagent` extension and exposed via the
// Symbol.for("pi-subagents:manager") global bridge (the same handle the tasks bridge reads).
// Read defensively: returns 0 when the subagent extension is absent or is an older build
// without getLifetimeCost.
const SUBAGENT_MANAGER_KEY = Symbol.for("pi-subagents:manager");

function getSubagentCost(): number {
  try {
    const handle = (globalThis as Record<symbol, unknown>)[SUBAGENT_MANAGER_KEY] as
      | { getLifetimeCost?: () => number }
      | undefined;
    const cost = handle?.getLifetimeCost?.();
    return typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
  } catch {
    return 0;
  }
}

// The goal extension publishes its current footer indicator on this Symbol.for() bridge
// instead of installing its own footer (only one footer slot exists). We claim ownership
// via VISUALS_FOOTER_OWNER_KEY (set in installFooterVisuals) so goal defers to us, then read
// the indicator here. Read defensively: returns null when goal is absent, has no active
// goal, or is an older build without the bridge.
const GOAL_FOOTER_BRIDGE_KEY = Symbol.for("pi-goal:footer");
const QUEUE_STEER_PENDING_WORK_KEY = Symbol.for("pi-queue-steer:pending-work");
const VISUALS_FOOTER_OWNER_KEY = Symbol.for("pi-visuals:footer");

function getGoalIndicator(ctx: Pick<ExtensionContext, "isIdle">): { text: string; color: ThemeColor } | null {
  try {
    const bridge = (globalThis as Record<symbol, unknown>)[GOAL_FOOTER_BRIDGE_KEY] as
      | { getIndicator?: (isIdle: boolean) => { text: string; color: ThemeColor } | null }
      | undefined;
    const indicator = bridge?.getIndicator?.(ctx.isIdle());
    if (!indicator || typeof indicator.text !== "string" || indicator.text.length === 0) {
      return null;
    }
    return indicator;
  } catch {
    return null;
  }
}

function hasQueueSteerPendingWork(): boolean {
  try {
    const bridge = (globalThis as Record<symbol, unknown>)[QUEUE_STEER_PENDING_WORK_KEY] as
      | { hasPendingWork?: () => boolean }
      | undefined;
    return bridge?.hasPendingWork?.() === true;
  } catch {
    return false;
  }
}

// Style one infrastructure status entry for the right of the status line. LSP (from the lsp
// extension) is special-cased: its status text is "LSP N/M running" only when N servers are
// active, and "LSP 0/M" / "LSP none" / "LSP disabled" otherwise. We show it only when at
// least one server is active, drop the trailing "running" phrase, and convey the active
// state by color. Non-LSP infra (MCP, ...) keeps the muted "KEY detail" form.
export function styleInfraEntry(text: string, theme: ExtensionContext["ui"]["theme"]): string | null {
  const cleaned = stripAnsi(sanitizeStatusText(text));
  if (/^LSP\b/.test(cleaned)) {
    const runningMatch = cleaned.match(/^LSP\s+(\d+)\/(\d+)\s+running$/);
    if (!runningMatch) return null; // none / disabled / 0 active → hide
    return theme.fg("success", `LSP ${runningMatch[1]}/${runningMatch[2]}`);
  }
  return theme.fg("muted", simplifyStatusText(text));
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
  mainCost: number,
  subagentCost: number,
  usingSubscription: boolean,
  theme: ExtensionContext["ui"]["theme"],
): string {
  const combined = mainCost + subagentCost;
  const costText = `$${combined.toFixed(3)}`;
  let label = usingSubscription ? `${costText} (sub)` : costText;
  if (subagentCost > 0) label += ` (+$${subagentCost.toFixed(3)} agents)`;

  // Subscription cost is notional, not actionable: never escalate its color.
  if (usingSubscription) return theme.fg("dim", label);
  if (combined >= 10) return theme.fg("error", label);
  if (combined >= 1) return theme.fg("warning", label);
  return theme.fg("dim", label);
}

function getPathLine(
  cwd: string,
  repoName: string | null,
  branch: string | null,
  theme: ExtensionContext["ui"]["theme"],
): string {
  const parts = [theme.fg("muted", repoName ?? (branch ? basename(cwd) : shortenPath(cwd)))];
  if (branch) parts.push(theme.fg("accent", branch));
  return parts.join(theme.fg("dim", " \u00b7 "));
}

// Repo name from git's common dir, so linked worktrees show the main repo, not the worktree dir.
function getRepoName(cwd: string): string | null {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    const name = basename(common) === ".git" ? basename(dirname(common)) : basename(common).replace(/\.git$/, "");
    return name || null;
  } catch {
    return null;
  }
}

function getModelSegment(
  ctx: Pick<ExtensionContext, "model">,
  thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>,
  multiProvider: boolean,
  fast: boolean,
  theme: ExtensionContext["ui"]["theme"],
): string {
  const model = theme.fg("muted", ctx.model?.id ?? "no-model");
  const name = multiProvider && ctx.model ? `${theme.fg("dim", `(${ctx.model.provider})`)} ${model}` : model;
  // Same hue Pi uses for the editor border at this thinking level.
  const effort = ctx.model?.reasoning ? theme.getThinkingBorderColor(thinkingLevel)(thinkingLevel) : "";
  const mode = effort + (fast ? theme.fg("dim", effort ? ":fast" : "fast") : "");
  return mode ? `${name}${theme.fg("dim", " · ")}${mode}` : name;
}

// Labeled token row: "in 10 · out 2.7k · cache 92%"
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
  // Cache hit rate: input excludes cached tokens, so the full prompt is input + read + write.
  const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
  if (totals.cacheRead && prompt) {
    const pct = Math.round((totals.cacheRead / prompt) * 100);
    // Turn 2 of a healthy session sits near 50% (turn 1 only writes), so warn below 30%.
    segs.push(theme.fg("dim", "cache ") + theme.fg(pct < 30 ? "warning" : "muted", `${pct}%`));
  }
  return segs.join(sep);
}

// Priority-ordered fit: drop lowest-priority segments first when overflowing.
// segments ordered by display order; priorities[i] = drop order (lower = drop first).
function fitSegmentsByPriority(
  segments: string[],
  priorities: number[],
  width: number,
  sep: string,
): string {
  const items = segments.map((s, i) => ({ text: s, priority: priorities[i] ?? 0, order: i }));
  const render = () =>
    items
      .filter((x) => x !== null)
      .sort((a, b) => a.order - b.order)
      .map((x) => x.text)
      .join(" · ");

  const active = items.slice();
  let line = active.map((x) => x.text).join(sep);
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
    line = active.sort((a, b) => a.order - b.order).map((x) => x.text).join(sep);
  }
  return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
}

export function installFooterVisuals(pi: ExtensionAPI): void {
  // Claim the single footer slot so cooperating extensions (e.g. goal) publish their state
  // via a bridge and defer to us instead of calling setFooter() themselves.
  (globalThis as Record<symbol, unknown>)[VISUALS_FOOTER_OWNER_KEY] = true;
  let currentCtx: ExtensionContext | null = null;
  let compactionPending = false;

  function compactOverLimitContext(ctx: ExtensionContext): void {
    if (compactionPending || ctx.hasPendingMessages() || hasQueueSteerPendingWork()) return;

    const usage = ctx.getContextUsage();
    if (
      typeof usage?.tokens !== "number" ||
      usage.contextWindow <= 0 ||
      usage.tokens <= usage.contextWindow
    ) {
      return;
    }

    compactionPending = true;
    const clearPending = () => {
      compactionPending = false;
    };
    ctx.compact({
      onComplete: clearPending,
      onError: clearPending,
    });
  }

  function installFooter(ctx: ExtensionContext): void {
    currentCtx = ctx;
    if (!ctx.hasUI) return;
    const repoName = getRepoName(ctx.cwd);

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
            getPathLine(ctx.cwd, repoName, branch, theme),
            width,
            theme.fg("dim", "..."),
          );

          const totals = getUsageTotals(ctx);
          const subagentCost = getSubagentCost();
          const usingSubscription = ctx.model
            ? ctx.model.provider === "kimi-coding" || ctx.modelRegistry.isUsingOAuth(ctx.model)
            : false;

          // Stats segments with priority (higher = keep longer).
          // ctx(4) > model(3) > tps(2) > cost(1)
          const statsSegments: string[] = [];
          const priorities: number[] = [];

          statsSegments.push(getContextSegment(ctx, theme));
          priorities.push(4);

          const statuses = footerData.getExtensionStatuses();
          const multiProvider = footerData.getAvailableProviderCount() > 1;
          statsSegments.push(getModelSegment(ctx, pi.getThinkingLevel(), multiProvider, statuses.get("fast") === "fast", theme));
          priorities.push(3);

          const tps = lastGenerationTps;
          if (tps !== null) {
            statsSegments.push(theme.fg("dim", formatTps(tps)));
            priorities.push(2);
          }

          if (totals.cost || subagentCost || usingSubscription) {
            statsSegments.push(getCostSegment(totals.cost, subagentCost, usingSubscription, theme));
            priorities.push(1);
          }

          const tokenRight = formatTokenRow(totals, theme);

          const lines = [pathLine];
          const sessionName = ctx.sessionManager.getSessionName();
          if (sessionName) {
            lines.push(truncateToWidth(theme.fg("text", sessionName), width, theme.fg("dim", "...")));
          }
          const availableLeft = tokenRight
            ? Math.max(10, width - visibleWidth(tokenRight) - 2)
            : width;
          const statsLeft = fitSegmentsByPriority(statsSegments, priorities, availableLeft, theme.fg("dim", " · "));

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

          // Status line: extension statuses, with hidden keys filtered out.
          const statusEntries = Array.from(statuses.entries())
            .filter(([key]) => !HIDDEN_STATUS_KEYS.has(key))
            .sort(([a], [b]) => a.localeCompare(b));

          // Infrastructure statuses (MCP, LSP, etc.) go far-right on the status line.
          const infraPattern = /^(MCP|LSP)\b/;
          const infraEntries = statusEntries.filter(([, text]) =>
            infraPattern.test(stripAnsi(sanitizeStatusText(text))),
          );

          // Right-aligned group: the goal indicator sits at the left of this group (i.e. to
          // the left of LSP), followed by the infra statuses. LSP is colorized and only
          // shown when it has active servers; other infra keeps its muted "KEY detail" form.
          const rightParts: string[] = [];
          const goalIndicator = getGoalIndicator(ctx);
          if (goalIndicator) {
            rightParts.push(theme.fg(goalIndicator.color, goalIndicator.text));
          }
          for (const [, text] of infraEntries) {
            const styled = styleInfraEntry(text, theme);
            if (styled) rightParts.push(styled);
          }
          const infraRight = rightParts.join(theme.fg("dim", " \u00b7 "));

          const extraEntries = statusEntries.filter(([, text]) => {
            const cleaned = stripAnsi(sanitizeStatusText(text));
            return cleaned && !infraPattern.test(cleaned);
          });
          if (extraEntries.length > 0 || infraRight) {
            const styledEntries = extraEntries
              .map(([key, text]) => {
                if (key === "agent-mode") return stripLeadingGlyph(text);
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

  const resetRate = () => {
    firstTokenAt = null;
    lastTokenAt = null;
    lastGenerationTps = null;
  };

  let firstTokenAt: number | null = null;
  let lastTokenAt: number | null = null;
  let lastGenerationTps: number | null = null;

  pi.on("turn_start", async () => {
    firstTokenAt = null;
    lastTokenAt = null;
  });

  pi.on("before_provider_request", async () => {
    firstTokenAt = null;
    lastTokenAt = null;
  });

  pi.on("message_start", async (event) => {
    if (event.message.role === "assistant") {
      firstTokenAt = null;
      lastTokenAt = null;
    }
  });

  pi.on("message_update", async (event) => {
    if (event.message.role !== "assistant") return;
    const update = event.assistantMessageEvent;
    if (
      (update.type !== "text_delta" && update.type !== "thinking_delta" && update.type !== "toolcall_delta") ||
      update.delta.length === 0
    ) return;
    const now = performance.now();
    if (!Number.isFinite(now)) return;
    if (firstTokenAt === null) firstTokenAt = now;
    lastTokenAt = now;
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;
    const startedAt = firstTokenAt;
    const endedAt = lastTokenAt;
    firstTokenAt = null;
    lastTokenAt = null;

    const tokens = event.message.usage.output - 1;
    const durationMs = (endedAt ?? NaN) - (startedAt ?? NaN);
    if (
      event.message.stopReason === "error" ||
      event.message.stopReason === "aborted" ||
      !Number.isFinite(tokens) ||
      tokens <= 0 ||
      !Number.isFinite(durationMs) ||
      durationMs < 250
    ) {
      return;
    }

    const rate = tokens / (durationMs / 1000);
    if (Number.isFinite(rate)) lastGenerationTps = rate;
  });

  pi.on("session_start", async (_event, ctx) => {
    resetRate();
    compactionPending = false;
    installFooter(ctx);
  });

  pi.on("session_tree", resetRate);
  pi.on("session_shutdown", resetRate);

  pi.on("model_select", async (_event, ctx) => {
    installFooter(ctx);
  });

  // Native auto-compaction settles first. This catches any still-over-limit
  // context without racing retries, queued continuations, or native compaction.
  pi.on("agent_settled", async (_event, ctx) => {
    compactOverLimitContext(ctx);
  });

  // Keep currentCtx reference updated (silences unused-var lint if added later).
  void currentCtx;
}
