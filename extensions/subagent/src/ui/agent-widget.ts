/**
 * agent-widget.ts — Persistent widget showing running/completed agents above the editor.
 *
 * Displays a tree of agents with animated spinners, live stats, and activity descriptions.
 * Uses the callback form of setWidget for themed rendering.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatCost, formatTokens as styleTokens, formatTurns as styleTurns, joinStats, SEPARATOR, SPINNER as STYLE_SPINNER } from "../../../lib/widget-style.js";
import { formatLifetimeTokens, type LifetimeUsage } from "../usage.js";
import { groupByStatus } from "../../../lib/status-group.js";
import type { AgentManager } from "../agent-manager.js";
import { getAgentConfig } from "../agent-types.js";
import type { AgentInvocationStatus, RestoreFailureReason, SubagentType } from "../types.js";
import { renderSubagentSummary } from "./summary-renderer.js";
import type { SubagentSummaryAgent, SubagentSummaryStatus } from "./summary-renderer.js";

// ---- Constants ----

/** Maximum number of rendered lines before overflow collapse kicks in. */
const MAX_WIDGET_LINES = 12;

/** Braille spinner frames for animated running indicator. */
export const SPINNER = STYLE_SPINNER;

/** Minimum time between animation-only renders while active agents are unchanged. */
const ACTIVE_RENDER_CADENCE_MS = 150;

/** Dim a running agent's row after this much idle time (no progress signal) — a quiet "stuck" indicator. */
const AGENT_IDLE_DIM_AFTER_MS = 15_000;

/** Statuses that indicate an error/non-success outcome (used for linger behavior and icon rendering). */
export const ERROR_STATUSES = new Set(["error", "aborted", "steered", "stopped"]);

/** Tool name → human-readable action for activity descriptions. */
const TOOL_DISPLAY: Record<string, string> = {
  read: "reading",
  bash: "running command",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding files",
  ls: "listing",
};

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

type AgentRecord = ReturnType<AgentManager["listAgents"]>[number];

/** Per-agent live activity state. */
export interface AgentActivity {
  activeTools: Map<string, string>;
  toolUses: number;
  tokens: string;
  responseText: string;
  session?: { getSessionStats(): { tokens: { total: number } } };
  /** Current turn count. */
  turnCount: number;
  /** Effective max turns for this agent (undefined = unlimited). */
  maxTurns?: number;
  /** Timestamp of the last observed progress signal for stale-agent supervision. */
  lastProgressAt: number;
}

/** Metadata attached to Agent tool results for custom rendering. */
export interface AgentDetails {
  displayName: string;
  description: string;
  subagentType: string;
  toolUses: number;
  tokens: string;
  /** Pre-formatted cost segment (e.g. "$0.340" or "$0.340 (sub)"). */
  cost?: string;
  durationMs: number;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error" | "background";
  /** Human-readable description of what the agent is currently doing. */
  activity?: string;
  /** Current spinner frame index (for animated running indicator). */
  spinnerFrame?: number;
  /** Short model name if different from parent (e.g. "haiku", "sonnet"). */
  modelName?: string;
  /** Notable config tags (e.g. ["thinking: high", "isolated"]). */
  tags?: string[];
  /** Current turn count. */
  turnCount?: number;
  /** Effective max turns (undefined = unlimited). */
  maxTurns?: number;
  agentId?: string;
  /** How this Agent invocation was routed. */
  invocationStatus?: AgentInvocationStatus;
  /** Stable machine-readable reason for a failed continuation. */
  failureReason?: RestoreFailureReason;
  /** Stable delegation-policy denial metadata. */
  category?: "delegation_policy_denied";
  activeMode?: string;
  requestedType?: string;
  permittedTypes?: string[];
  error?: string;
}

// ---- Formatting helpers ----

/** Format a token count compactly: "33.8k", "1.2M". Delegates to shared style. */
export function formatTokens(count: number): string {
  return styleTokens(count);
}

/** Format turn count with optional max limit: "↻5≤30" or "↻5". Delegates to shared style. */
export function formatTurns(turnCount: number, maxTurns?: number | null): string {
  return styleTurns(turnCount, maxTurns);
}

/** Join status stats without padding around separators to keep widget compact. */
export function formatStatusParts(parts: string[]): string {
  return parts.join("·");
}

/** Format milliseconds as a fixed-decimal duration (e.g. "5.7s"); used by the conversation viewer. */
export function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Format duration from start/completed timestamps. */
export function formatDuration(startedAt: number, completedAt?: number): string {
  if (completedAt) return formatMs(completedAt - startedAt);
  return `${formatMs(Date.now() - startedAt)} (running)`;
}

/** Get display name for any agent type (built-in or custom). */
export function getDisplayName(type: SubagentType): string {
  const config = getAgentConfig(type);
  return config?.displayName ?? config?.name ?? type;
}

/** Short label for prompt mode: "twin" for append, nothing for replace (the default). */
export function getPromptModeLabel(type: SubagentType): string | undefined {
  const config = getAgentConfig(type);
  return config?.promptMode === "append" ? "twin" : undefined;
}

/** Truncate text to a single line, max `len` chars. */
function truncateLine(text: string, len = 60): string {
  const line = text.split("\n").find(l => l.trim())?.trim() ?? "";
  if (line.length <= len) return line;
  return line.slice(0, len) + "…";
}

/** Build a human-readable activity string from currently-running tools or response text. */
export function describeActivity(activeTools: Map<string, string>, responseText?: string): string {
  if (activeTools.size > 0) {
    const groups = new Map<string, number>();
    for (const toolName of activeTools.values()) {
      const action = TOOL_DISPLAY[toolName] ?? toolName;
      groups.set(action, (groups.get(action) ?? 0) + 1);
    }

    const parts: string[] = [];
    for (const [action, count] of groups) {
      if (count > 1) {
        parts.push(`${action} ${count} ${action === "searching" ? "patterns" : "files"}`);
      } else {
        parts.push(action);
      }
    }
    return parts.join(", ") + "…";
  }

  // No tools active — show truncated response text if available
  if (responseText && responseText.trim().length > 0) {
    return truncateLine(responseText);
  }

  return "thinking…";
}

// ---- Widget manager ----

export class AgentWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** Tracks how many turns each finished agent has survived. Key: agent ID, Value: turns since finished. */
  private finishedTurnAge = new Map<string, number>();
  /** How many extra turns errors/aborted agents linger (completed agents clear after 1 turn). */
  private static readonly ERROR_LINGER_TURNS = 2;

  /** Whether the widget callback is currently registered with the TUI. */
  private widgetRegistered = false;
  /** Cached TUI reference from widget factory callback, used for requestRender(). */
  private tui: any | undefined;
  /** Last status bar text, used to avoid redundant setStatus calls. */
  private lastStatusText: string | undefined;
  /** Last live-state signature rendered by the widget callback. */
  private lastRenderSignature: string | undefined;
  /** Last time an animation-only render was requested. */
  private lastRenderAt = 0;
  /** Whether the current session bills via subscription/OAuth (cost shown as estimate). */
  private usingSubscription = false;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
  ) {}

  /** Set the UI context (grabbed from first tool execution). */
  setUICtx(ctx: UICtx) {
    if (ctx !== this.uiCtx) {
      // UICtx changed — the widget registered on the old context is gone.
      // Force re-registration on next update().
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
      this.lastStatusText = undefined;
      this.lastRenderSignature = undefined;
      this.lastRenderAt = 0;
    }
  }

  /** Update whether the current session bills via subscription/OAuth (affects cost display). */
  setUsingSubscription(usingSubscription: boolean) {
    this.usingSubscription = usingSubscription;
  }

  /**
   * Called on each new turn (tool_execution_start).
   * Ages finished agents and clears those that have lingered long enough.
   */
  onTurnStart() {
    // Age all finished agents
    for (const [id, age] of this.finishedTurnAge) {
      this.finishedTurnAge.set(id, age + 1);
    }
    // Trigger a widget refresh (will filter out expired agents)
    this.update();
  }

  /** Ensure the widget update timer is running. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), ACTIVE_RENDER_CADENCE_MS);
    }
  }

  /** Check if a finished agent should still be shown in the widget. */
  private shouldShowFinished(agentId: string, status: string): boolean {
    const age = this.finishedTurnAge.get(agentId) ?? 0;
    const maxAge = ERROR_STATUSES.has(status) ? AgentWidget.ERROR_LINGER_TURNS : 1;
    return age < maxAge;
  }

  /** Record an agent as finished (call when agent completes). */
  markFinished(agentId: string) {
    if (!this.finishedTurnAge.has(agentId)) {
      this.finishedTurnAge.set(agentId, 0);
    }
  }

  private getDisplayNameWithMode(type: SubagentType): string {
    const name = getDisplayName(type);
    const modeLabel = getPromptModeLabel(type);
    return modeLabel ? `${name} (${modeLabel})` : name;
  }

  private lifetimeTokenText(usage?: LifetimeUsage): string | undefined {
    if (!usage) return undefined;
    const total = usage.input + usage.output + usage.cacheWrite;
    return total > 0 ? formatLifetimeTokens(usage) : undefined;
  }

  private costText(cost?: number): string | undefined {
    if (!cost || cost <= 0) return undefined;
    const base = formatCost(cost);
    return this.usingSubscription ? `${base} (sub)` : base;
  }

  /** Render a finished agent line. */
  private renderFinishedLine(a: AgentRecord): string {
    const activity = this.agentActivity.get(a.id);
    const summary: SubagentSummaryAgent = {
      displayName: this.getDisplayNameWithMode(a.type),
      description: a.description,
      status: a.status as SubagentSummaryStatus,
      toolUses: a.toolUses,
      tokens: this.lifetimeTokenText(a.lifetimeUsage),
      cost: this.costText(a.lifetimeCost),
      durationMs: (a.completedAt ?? Date.now()) - a.startedAt,
      modelName: a.modelLabel,
      turnCount: activity?.turnCount,
      maxTurns: activity?.maxTurns,
      error: a.error,
      compactionCount: a.compactionCount,
    };
    return renderSubagentSummary(summary)[0] ?? "";
  }


  /**
   * Render the widget content. Called from the registered widget's render() callback,
   * reading live state each time instead of capturing it in a closure.
   */
  private renderWidget(tui: any, theme: Theme): string[] {
    const allAgents = this.manager.listAgents();
    const groupedAgents = groupByStatus(allAgents);
    const running = groupedAgents.running ?? [];
    const queued = groupedAgents.queued ?? [];
    const finished = allAgents.filter(a =>
      a.status !== "running" && a.status !== "queued" && a.completedAt
      && this.shouldShowFinished(a.id, a.status),
    );

    const hasActive = running.length > 0 || queued.length > 0;
    const hasFinished = finished.length > 0;

    // Nothing to show — return empty (widget will be unregistered by update())
    if (!hasActive && !hasFinished) return [];

    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);
    const headingColor = hasActive ? "accent" : "dim";
    const headingIcon = hasActive ? "●" : "○";
    // Build sections separately for overflow-aware assembly.
    // Each running agent = 2 lines (header + activity), finished = 1 line, queued = 1 line.

    const finishedLines: string[] = [];
    for (const a of finished) {
      finishedLines.push(truncate(`${theme.fg("dim", "├─")} ${this.renderFinishedLine(a)}`));
    }

    const runningLines: string[][] = []; // each entry is [header, activity]
    for (const a of running) {
      const bg = this.agentActivity.get(a.id);
      const toolUses = bg?.toolUses ?? a.toolUses;
      const activity = bg ? describeActivity(bg.activeTools, bg.responseText) : "thinking…";
      const summaryLines = renderSubagentSummary({
        displayName: this.getDisplayNameWithMode(a.type),
        description: a.description,
        status: "running",
        activity,
        spinnerFrame: this.widgetFrame,
        modelName: a.modelLabel,
        turnCount: bg?.turnCount,
        maxTurns: bg?.maxTurns,
        toolUses,
        tokens: this.lifetimeTokenText(a.lifetimeUsage),
        cost: this.costText(a.lifetimeCost),
        durationMs: Date.now() - a.startedAt,
        compactionCount: a.compactionCount,
      });

      const idleMs = Date.now() - (bg?.lastProgressAt ?? a.startedAt);
      const rowColor = idleMs >= AGENT_IDLE_DIM_AFTER_MS ? "dim" : "accent";
      runningLines.push([
        truncate(`${theme.fg("dim", "├─")} ${theme.fg(rowColor, summaryLines[0] ?? "")}`),
        truncate(`${theme.fg("dim", "│  ")}${theme.fg("dim", summaryLines[1] ?? "└─ thinking…")}`),
      ]);
    }

    const queuedLine = queued.length > 0
      ? truncate(`${theme.fg("dim", "├─")} ${renderSubagentSummary({ title: `${queued.length} queued`, status: "queued", agents: [] })[0] ?? `◦ ${queued.length} queued`}`)
      : undefined;

    // Assemble with overflow cap (heading + overflow indicator = 2 reserved lines).
    const maxBody = MAX_WIDGET_LINES - 1; // heading takes 1 line
    const totalBody = finishedLines.length + runningLines.length * 2 + (queuedLine ? 1 : 0);

    const summary = joinStats([
      running.length > 0 ? `${running.length} running` : "",
      queued.length > 0 ? `${queued.length} queued` : "",
    ]);
    const heading = summary
      ? `${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, "Agents")}${theme.fg("dim", SEPARATOR + summary)}`
      : `${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, "Agents")}`;
    const lines: string[] = [truncate(heading)];

    if (totalBody <= maxBody) {
      // Everything fits — add all lines and fix up connectors for the last item.
      lines.push(...finishedLines);
      for (const pair of runningLines) lines.push(...pair);
      if (queuedLine) lines.push(queuedLine);

      // Fix last connector: swap ├─ → └─ and │ → space for activity lines.
      if (lines.length > 1) {
        const last = lines.length - 1;
        lines[last] = lines[last].replace("├─", "└─");
        // If the last item is a running agent activity line, fix its indent too.
        if (runningLines.length > 0 && !queuedLine) {
          if (last >= 2) {
            lines[last - 1] = lines[last - 1].replace("├─", "└─");
            lines[last] = lines[last].replace("│  ", "   ");
          }
        }
      }
    } else {
      // Overflow — prioritize: running > queued > finished.
      // Reserve 1 line for overflow indicator.
      let budget = maxBody - 1;
      let hiddenRunning = 0;
      let hiddenFinished = 0;

      // 1. Running agents (2 lines each)
      for (const pair of runningLines) {
        if (budget >= 2) {
          lines.push(...pair);
          budget -= 2;
        } else {
          hiddenRunning++;
        }
      }

      // 2. Queued line
      if (queuedLine && budget >= 1) {
        lines.push(queuedLine);
        budget--;
      }

      // 3. Finished agents
      for (const fl of finishedLines) {
        if (budget >= 1) {
          lines.push(fl);
          budget--;
        } else {
          hiddenFinished++;
        }
      }

      // Overflow summary
      const overflowParts: string[] = [];
      if (hiddenRunning > 0) overflowParts.push(`${hiddenRunning} running`);
      if (hiddenFinished > 0) overflowParts.push(`${hiddenFinished} finished`);
      const overflowText = overflowParts.join(", ");
      lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${hiddenRunning + hiddenFinished} more (${overflowText})`)}`)
      );
    }

    return lines;
  }

  private buildRenderSignature(allAgents: ReturnType<AgentManager["listAgents"]>): string {
    const agentParts = allAgents.map((agent) => {
      const activity = this.agentActivity.get(agent.id);
      const activeTools = activity ? Array.from(activity.activeTools.values()).join(",") : "";
      return [
        agent.id,
        agent.status,
        agent.completedAt ?? "",
        agent.toolUses,
        agent.error ?? "",
        agent.compactionCount ?? "",
        activity?.toolUses ?? "",
        activity?.tokens ?? "",
        activity?.responseText ?? "",
        activity?.turnCount ?? "",
        activity?.maxTurns ?? "",
        activeTools,
      ].join(":");
    });
    const finishedAges = Array.from(this.finishedTurnAge.entries()).map(([id, age]) => `${id}:${age}`).join(",");
    return `${agentParts.join("|")}|finished:${finishedAges}`;
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx) return;
    const allAgents = this.manager.listAgents();
    const groupedAgents = groupByStatus(allAgents);

    // Lightweight existence checks — full categorization happens in renderWidget()
    const runningCount = groupedAgents.running?.length ?? 0;
    const queuedCount = groupedAgents.queued?.length ?? 0;
    let hasFinished = false;
    for (const a of allAgents) {
      if (a.completedAt && this.shouldShowFinished(a.id, a.status)) { hasFinished = true; }
    }
    const hasActive = runningCount > 0 || queuedCount > 0;

    // Nothing to show — clear widget
    if (!hasActive && !hasFinished) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("agents", undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.lastStatusText !== undefined) {
        this.uiCtx.setStatus("subagents", undefined);
        this.lastStatusText = undefined;
      }
      if (this.widgetInterval) { clearInterval(this.widgetInterval); this.widgetInterval = undefined; }
      this.lastRenderSignature = undefined;
      this.lastRenderAt = 0;
      // Clean up stale entries
      for (const [id] of this.finishedTurnAge) {
        if (!allAgents.some(a => a.id === id)) this.finishedTurnAge.delete(id);
      }
      return;
    }

    // Status bar — only call setStatus when the text actually changes
    let newStatusText: string | undefined;
    if (hasActive) {
      const statusParts: string[] = [];
      if (runningCount > 0) statusParts.push(`${runningCount} running`);
      if (queuedCount > 0) statusParts.push(`${queuedCount} queued`);
      const total = runningCount + queuedCount;
      newStatusText = `${statusParts.join(", ")} agent${total === 1 ? "" : "s"}`;
    }
    if (newStatusText !== this.lastStatusText) {
      this.uiCtx.setStatus("subagents", newStatusText);
      this.lastStatusText = newStatusText;
    }

    const renderSignature = this.buildRenderSignature(allAgents);
    const now = Date.now();

    // Register widget callback once; subsequent updates use requestRender()
    // which re-invokes render() without replacing the component (avoids layout thrashing).
    if (!this.widgetRegistered) {
      this.widgetFrame++;
      this.lastRenderSignature = renderSignature;
      this.lastRenderAt = now;
      this.uiCtx.setWidget("agents", (tui, theme) => {
        this.tui = tui;
        return {
          render: () => this.renderWidget(tui, theme),
          invalidate: () => {
            // Theme changed — force re-registration so factory captures fresh theme.
            this.widgetRegistered = false;
            this.tui = undefined;
            this.lastRenderSignature = undefined;
          },
        };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
      return;
    }

    const stateChanged = renderSignature !== this.lastRenderSignature;
    const cadenceElapsed = hasActive && now - this.lastRenderAt >= ACTIVE_RENDER_CADENCE_MS;
    if (!stateChanged && !cadenceElapsed) return;

    this.widgetFrame++;
    this.lastRenderSignature = renderSignature;
    this.lastRenderAt = now;
    this.tui?.requestRender();
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget("agents", undefined);
      this.uiCtx.setStatus("subagents", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastStatusText = undefined;
    this.lastRenderSignature = undefined;
    this.lastRenderAt = 0;
  }
}
