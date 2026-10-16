/**
 * fleet-list.ts — Claude Code-style "FleetView" list rendered below the editor.
 *
 * Shows `main` + openable subagents as a navigable list, plus an aggregate queue.
 * Pressing ↓ or ← at an empty prompt activates it; ↑/↓ move the selection (filled ● marker),
 * Enter opens the selected agent's live conversation overlay, Esc returns to the prompt.
 * A viewer stays open when its agent finishes; finished agents linger briefly in the list.
 *
 * Mechanics (see plan): the list is a `belowEditor` widget (render-only), and ALL key
 * handling goes through `onTerminalInput` — which fires before the focused editor and
 * can `consume` keys — gated on `getEditorText() === ""` so normal typing is untouched.
 */

import { Editor, isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentManager } from "../agent-manager.js";
import { getSessionFast } from "../session-fast.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import { agentStatusWord, statusMark } from "./agent-monitor.js";
import { type AgentActivity, formatTurns, getDisplayName, SPINNER, type Theme } from "./agent-widget.js";
import { openConversationOverlay } from "./conversation-overlay.js";

/** Widget key for the below-editor fleet list. */
const FLEET_KEY = "fleet";
/** Max agent rows shown at once; extras collapse into a "↓ N more" indicator. */
const MAX_AGENT_ROWS = 8;
/** Re-render cadence so elapsed/token stats tick while agents run. */
const TICK_MS = 200;
/** How long a finished agent lingers in the list before it drops out. */
const FINISHED_LINGER_MS = 4000;
const FAILED_LINGER_MS = 30_000;

/** Minimal UI surface the FleetView needs from `ctx.ui` (structural subset). */
export type FleetUICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(width: number): string[]; invalidate(): void; dispose?(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (tui: any, theme: Theme, keybindings: any, done: (result: T) => void) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
  ): Promise<T>;
};

/**
 * A graph run, as the fleet list needs to see it.
 *
 * Narrow on purpose: the list knows nothing about `GraphRunTask`, the runtime
 * or the dialog, so it stays as testable as it was when it only held agents.
 * The extension maps its tasks into this shape and injects an opener.
 */
export interface FleetGraphRun {
  id: string;
  /** The `meta.name` of the run, or its id when the script named nothing. */
  name: string;
  status: "running" | "completed" | "failed" | "killed" | "paused";
  doneCount: number;
  totalCount: number;
  startedAt: number;
  /** Set once the run settles, which is what freezes its clock. */
  completedAt?: number;
  tokens: number;
}

type MainEntry = { kind: "main" };
type AgentEntry = { kind: "agent"; record: AgentRecord };
type GraphRunEntry = { kind: "graphRun"; graphRun: FleetGraphRun };
type FleetEntry = MainEntry | GraphRunEntry | AgentEntry;

/** `11s` — integer seconds, no decimal/suffix (matches Claude Code, unlike formatMs). */
export function formatFleetElapsed(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** `↓ 13.1k tokens` — down-arrow prefix, compact magnitude, plural "tokens". */
export function formatFleetTokens(count: number): string {
  let compact: string;
  if (count >= 1_000_000) compact = `${(count / 1_000_000).toFixed(1)}M`;
  else if (count >= 1_000) compact = `${(count / 1_000).toFixed(1)}k`;
  else compact = `${count}`;
  return `↓ ${compact} tokens`;
}

/**
 * Place `right` flush to `width`, truncating `left` first so the stats survive.
 * The final clamp guarantees the line never exceeds `width` (which would wrap and
 * desync pi's line-diff → flicker) even on a terminal too narrow for the stats.
 */
function rightAlign(left: string, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(0, width - rightW - 1);
  const leftClamped = truncateToWidth(left, maxLeft);
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

function graphRunStats(graphRun: FleetGraphRun, showAgentCount = true): string {
  const elapsed = (graphRun.completedAt ?? Date.now()) - graphRun.startedAt;
  const agents = `${graphRun.doneCount}/${graphRun.totalCount} agent${graphRun.totalCount === 1 ? "" : "s"}`;
  return `${showAgentCount ? `${agents} · ` : ""}${formatFleetElapsed(elapsed)} · ${formatFleetTokens(graphRun.tokens)}`;
}

/**
 * A run's row. Shaped like an agent's — bullet, kind, name, stats flush right
 * — so the two read as one list, with the agent count where an agent has its
 * description and the same elapsed/token tail.
 *
 * `statusWord`, when set, is caller-styled and prefixes dim stats. The fleet strip omits it.
 */
export function formatFleetGraphRunRow(
  bullet: string,
  selected: boolean,
  graphRun: FleetGraphRun,
  width: number,
  theme: Theme,
  statusWord?: string,
  showAgentCount = true,
): string {
  const kind = theme.fg(selected ? "text" : "muted", "graph run");
  const name = selected ? theme.fg("text", graphRun.name) : graphRun.name;
  const left = `  ${bullet} ${kind}  ${name}`;
  const stats = graphRunStats(graphRun, showAgentCount);
  if (statusWord === undefined) {
    return rightAlign(left, selected ? theme.fg("text", stats) : theme.fg("dim", stats), width);
  }
  return rightAlign(left, statusWord + theme.fg("dim", ` · ${stats}`), width);
}

/** An agent's row. `statusWord`, when set, prefixes the right-hand stats. */
export function formatFleetAgentRow(
  bullet: string,
  record: AgentRecord,
  tokens: number,
  width: number,
  theme: Theme,
  statusWord?: string,
): string {
  const left = `  ${bullet} ${theme.fg("muted", getDisplayName(record.type))}  ${record.description}`;
  const elapsedMs = (record.completedAt ?? Date.now()) - record.startedAt; // freezes once finished
  const stats = `${formatFleetElapsed(elapsedMs)} · ${formatFleetTokens(tokens)}`;
  if (statusWord === undefined) return rightAlign(left, theme.fg("dim", stats), width);
  return rightAlign(left, statusWord + theme.fg("dim", ` · ${stats}`), width);
}

export class FleetList {
  private ui: FleetUICtx | undefined;
  private tui: any | undefined;
  private inputUnsub: (() => void) | undefined;
  private widgetRegistered = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  private frame = 0;
  private lastStatusText: string | undefined;

  private enabled = true;
  /** Whether arrow keys currently navigate the list (vs. flow to the editor). */
  private active = false;
  /** 0 = `main`, 1..N = subagents. */
  private selectedIndex = 0;
  /** Set while a conversation overlay is open; calling it closes the overlay. */
  private viewerClose: (() => void) | undefined;
  private viewingAgentId: string | undefined;
  /** Injected by the extension; absent until graph runs are wired (or at all). */
  private graphRunSource: (() => readonly FleetGraphRun[]) | undefined;
  private openGraphRun: ((id: string) => Promise<void> | void) | undefined;
  /**
   * Set while the graph run inspector is up.
   *
   * It does the two jobs `viewerClose` does for an agent's overlay — keep the
   * list out of the dialog's keys, and remember which row to come back to —
   * minus the close handle, because that overlay belongs to the extension.
   */
  private viewingGraphRunId: string | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
  ) {}

  // ---- Lifecycle ----

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.active = false;
    this.update();
  }

  /** Capture the UI context and (re)register the global input handler. */
  setUICtx(ui: FleetUICtx): void {
    if (ui === this.ui) return;
    this.inputUnsub?.();
    this.ui = ui;
    this.lastStatusText = undefined;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.inputUnsub = ui.onTerminalInput(data => this.handleKey(data));
  }

  /** Ensure the re-render timer is running (called when an agent spawns). */
  ensureTimer(): void {
    if (!this.timer) this.timer = setInterval(() => this.update(), TICK_MS);
  }

  /**
   * Called when an agent finishes. The viewer (if open on it) stays open so the
   * final output remains readable, and the row lingers in the list — just refresh.
   */
  onAgentFinished(_id: string): void {
    this.update();
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    if (this.viewerClose) { this.viewerClose(); this.viewerClose = undefined; }
    this.viewingAgentId = undefined;
    // No handle to close the graph run inspector with, but the list is going
    // away — leaving the id set would keep it swallowing input forever.
    this.viewingGraphRunId = undefined;
    if (this.ui && this.widgetRegistered) this.ui.setWidget(FLEET_KEY, undefined);
    this.ui?.setStatus("subagents", undefined);
    this.lastStatusText = undefined;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.active = false;
    // Null last so a `viewerClose()` microtask above can't re-register the widget.
    this.ui = undefined;
  }

  /** Re-register/refresh the below-editor widget; clears it when nothing remains. */
  update(): void {
    if (!this.ui) return;
    const agents = this.manager.listAgents().filter(a => !a.graphRunId);
    const running = agents.filter(a => a.status === "running").length;
    const queued = agents.filter(a => a.status === "queued").length;
    const total = running + queued;
    const statusText = total > 0
      ? `${running} running${queued > 0 ? `, ${queued} queued` : ""} agent${total === 1 ? "" : "s"}`
      : undefined;
    if (statusText !== this.lastStatusText) {
      this.ui.setStatus("subagents", statusText);
      this.lastStatusText = statusText;
    }
    // A run with no agents of its own left in the list is still worth a row —
    // it is the thing the user opens to see what its children did. Read off the
    // roster for the same reason activation does: two counts of "is there
    // anything here" drifted apart once before.
    const hasRows = this.enabled && (this.roster().length > 1 || queued > 0);

    if (!hasRows) {
      if (this.widgetRegistered) {
        this.ui.setWidget(FLEET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (total > 0) this.ensureTimer();
      else if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      this.active = false;
      this.selectedIndex = 0;
      return;
    }

    this.clampSelection();
    this.ensureTimer(); // keep stats ticking whenever the list is shown (e.g. after a re-enable)

    if (!this.widgetRegistered) {
      this.ui.setWidget(FLEET_KEY, (tui, theme) => {
        this.tui = tui;
        return {
          render: (w: number) => this.renderBar(w, theme),
          invalidate: () => { this.widgetRegistered = false; this.tui = undefined; },
        };
      }, { placement: "belowEditor" });
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  // ---- Roster ----

  /**
   * Agents shown in the list, ordered earliest-launched first so the ones you
   * started sooner sit at the top. Every row is openable (has a session), so Enter
   * never dead-ends. Included: running, plus the agent currently being
   * viewed, plus recently-finished ones (they linger briefly before dropping out).
   * Queued agents are summarized separately rather than selectable.
   * (`listAgents()` is newest-first, so we re-sort.)
   */
  private agentRecords(): AgentRecord[] {
    const now = Date.now();
    const candidates = this.manager.listAgents()
      .filter(a => !a.graphRunId && a.session && a.status !== "queued")
      .sort((a, b) => a.startedAt - b.startedAt);
    const byId = new Map(candidates.map(a => [a.id, a]));
    const retained = new Set(candidates.filter(a =>
      a.status === "running" || a.id === this.viewingAgentId
      || (a.completedAt != null && now - a.completedAt < (
        a.status === "completed" ? FINISHED_LINGER_MS : FAILED_LINGER_MS
      )),
    ).map(a => a.id));
    // Retain ancestors until their last visible child has gone, too.
    for (const agent of candidates) {
      if (!retained.has(agent.id)) continue;
      let parent = agent.parentAgentId ? byId.get(agent.parentAgentId) : undefined;
      while (parent && !retained.has(parent.id)) {
        retained.add(parent.id);
        parent = parent.parentAgentId ? byId.get(parent.parentAgentId) : undefined;
      }
    }
    const visible = candidates.filter(a => retained.has(a.id));
    const ordered: AgentRecord[] = [];
    const append = (agent: AgentRecord) => {
      ordered.push(agent);
      for (const child of visible.filter(a => a.parentAgentId === agent.id)) append(child);
    };
    for (const agent of visible) {
      if (!agent.parentAgentId || !retained.has(agent.parentAgentId)) append(agent);
    }
    return ordered;
  }

  /**
   * Wire graph runs into the list.
   *
   * Injected rather than constructed here because the fleet list predates
   * graph runs and must keep working without them — a session with the feature
   * switched off never calls this, and the roster is agents-only exactly as
   * before.
   */
  setGraphRunSource(
    source: () => readonly FleetGraphRun[],
    open: (id: string) => Promise<void> | void,
  ): void {
    this.graphRunSource = source;
    this.openGraphRun = open;
  }

  /** Live runs, plus recently settled ones — the same linger the agents get. */
  private graphRuns(): FleetGraphRun[] {
    if (!this.graphRunSource) return [];
    const now = Date.now();
    return [...this.graphRunSource()]
      .filter(run =>
        run.status === "running"
        || run.status === "paused"
        || (run.completedAt != null && now - run.completedAt < FINISHED_LINGER_MS)
      )
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Runs sit above the agents rather than interleaved by start time: a run owns
   * most of the agents under it, so listing the container first is what makes
   * the list read as a hierarchy rather than a shuffle.
   */
  private roster(): FleetEntry[] {
    return [
      { kind: "main" },
      ...this.graphRuns().map(graphRun => ({ kind: "graphRun" as const, graphRun })),
      ...this.agentRecords().map(record => ({ kind: "agent" as const, record })),
    ];
  }

  private clampSelection(): void {
    const max = this.roster().length - 1;
    if (this.selectedIndex > max) this.selectedIndex = Math.max(0, max);
    if (this.selectedIndex < 0) this.selectedIndex = 0;
  }

  // ---- Key handling ----

  /** Returns `{consume:true}` to swallow a key, or undefined to let it through. */
  handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.enabled || !this.ui) return undefined;
    // Input listeners receive BOTH key-press and key-release (the kitty protocol
    // emits both, and matchesKey matches either) — act on press only, or every
    // tap would move/fire twice. Repeats still pass through for held-key nav.
    if (isKeyRelease(data)) return undefined;
    // While an overlay is open, let it own all input. Checked before the focus
    // test below, which would otherwise read the dialog holding the keyboard as
    // "the user left the list" and reset the selection out from under it.
    if (this.viewerClose || this.viewingGraphRunId) return undefined;
    // Input listeners fire BEFORE the focused component, and dialogs
    // (ctx.ui.select/confirm/input, pi's own menus) swap the prompt editor out
    // while getEditorText() still reads the detached — empty — editor. So when
    // anything but the editor owns the keyboard, stay out of its keys (#123).
    if (!this.editorHasFocus()) {
      if (this.active) this.deactivate();
      return undefined;
    }

    if (!this.active) {
      // Activate: ↓ or ← at an empty prompt moves focus into the list.
      const isActivator = matchesKey(data, "down") || matchesKey(data, "left");
      // Gated on the roster, not the agents: a session whose only row is a
      // graph run still has somewhere to go, and requiring an agent would
      // render the row but refuse to move into it.
      const hasRows = this.roster().length > 1 || this.manager.listAgents().some(a => !a.graphRunId && a.status === "queued");
      if (isActivator && hasRows && this.ui.getEditorText() === "") {
        this.active = true;
        this.selectedIndex = 0;
        this.update();
        return { consume: true };
      }
      return undefined;
    }

    // Active — arrows navigate, Enter opens, Esc / Up-past-top exits.
    if (matchesKey(data, "down")) {
      const max = this.roster().length - 1;
      this.selectedIndex = Math.min(max, this.selectedIndex + 1);
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "up")) {
      if (this.selectedIndex === 0) { this.deactivate(); return { consume: true }; }
      this.selectedIndex -= 1;
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) { this.deactivate(); return { consume: true }; }
    if (matchesKey(data, Key.enter)) { this.openSelected(); return { consume: true }; }

    // Any other key cancels navigation and flows to the editor.
    this.deactivate();
    return undefined;
  }

  /**
   * True when pi's prompt editor owns the keyboard. pi's editor is an `Editor`
   * subclass (CustomEditor) while every dialog/selector is not, and the loader
   * aliases pi-tui to pi's own copy, so `instanceof` is a reliable identity
   * check. `focusedComponent` is TUI-private (no public accessor), hence the
   * best-effort peek: unknowable focus (no tui seen yet, nothing focused)
   * counts as the editor so activation keeps working.
   */
  private editorHasFocus(): boolean {
    const focused = (this.tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
    return focused == null || focused instanceof Editor;
  }

  private deactivate(): void {
    this.active = false;
    this.selectedIndex = 0;
    this.update();
  }

  private openSelected(): void {
    const entry = this.roster()[this.selectedIndex];
    if (!entry || entry.kind === "main") {
      // `main` = return to the prompt; the native transcript is already shown.
      this.deactivate();
      return;
    }
    if (entry.kind === "graphRun") {
      // The extension owns this overlay and closes it, so there is no
      // `viewerClose` to hold — but the list still has to know one is up, and
      // still has to put the cursor back on the run when it comes down.
      this.viewingGraphRunId = entry.graphRun.id;
      void Promise.resolve().then(() => this.openGraphRun?.(entry.graphRun.id)).then(
        () => this.clearViewer(),
        () => this.clearViewer(),
      );
      return;
    }
    const record = entry.record;
    if (!this.ui) return;
    this.viewingAgentId = record.id;
    void openConversationOverlay(this.ui, record, {
      manager: this.manager,
      agentActivity: this.agentActivity,
    }, {
      onOpen: close => { this.viewerClose = close; },
    }).then(() => this.clearViewer(), () => this.clearViewer());
  }

  /** Reset overlay state and return to the list (on close, auto-close, or error). */
  private clearViewer(): void {
    // Keep the cursor on the agent we were viewing — re-resolve by id so it
    // still feels natural if the list reordered (an earlier agent finished)
    // while the overlay was open. If that agent is gone, leave the index for
    // update()'s clamp to settle.
    const viewed = this.viewingAgentId ?? this.viewingGraphRunId;
    if (viewed !== undefined) {
      const idx = this.roster().findIndex(e =>
        e.kind === "agent" ? e.record.id === viewed
        : e.kind === "graphRun" ? e.graphRun.id === viewed
        : false,
      );
      if (idx >= 0) this.selectedIndex = idx;
    }
    this.viewerClose = undefined;
    this.viewingAgentId = undefined;
    this.viewingGraphRunId = undefined;
    this.update();
  }

  // ---- Rendering ----

  private renderBar(width: number, theme: Theme): string[] {
    const rows = this.roster().slice(1) as (GraphRunEntry | AgentEntry)[];
    const queued = this.manager.listAgents().filter(a => !a.graphRunId && a.status === "queued").length;
    if (rows.length === 0 && queued === 0) return [];
    this.frame = (this.frame + 1) % SPINNER.length;
    // Clamp locally so a render between a roster shrink and the next update()
    // (e.g. on terminal resize) never loses the selection marker.
    const sel = Math.min(this.selectedIndex, rows.length);

    const hint = this.active
      ? "↑↓ select · enter view · esc back"
      : "esc to interrupt · ← for agents · ↓ to manage";
    const lines: string[] = [];
    lines.push(truncateToWidth("  " + theme.fg("dim", hint), width));
    lines.push("");
    lines.push(truncateToWidth(`  ${this.bullet(0, sel, theme)} main`, width));

    // Window the rows so the selected one stays visible.
    const visible = Math.min(MAX_AGENT_ROWS, rows.length);
    const selRow = Math.max(0, sel - 1);
    const start = visible === 0 || selRow < visible ? 0 : selRow - visible + 1;
    const hiddenBelow = rows.length - (start + visible);

    const branches = new Map<string, string>();
    for (const row of rows) {
      if (row.kind !== "agent" || !rows.some(parent => parent.kind === "agent" && parent.record.id === row.record.parentAgentId)) continue;
      const siblings = rows.filter(sibling => sibling.kind === "agent" && sibling.record.parentAgentId === row.record.parentAgentId);
      branches.set(row.record.id, siblings.at(-1) === row ? "  └ " : "  ├ ");
    }
    // Pick one tier for the whole visible window, reserving sixteen description cells.
    let level = 0;
    while (level < 4 && rows.slice(start, start + visible).some(row => {
      const prefix = row.kind === "agent"
        ? this.agentRowPrefix(row.record, branches.get(row.record.id) ?? "", theme)
        : "graph run  ";
      const stats = row.kind === "agent"
        ? this.agentRowStats(row.record, level, theme)
        : graphRunStats(row.graphRun);
      return width - 4 - visibleWidth(prefix) - visibleWidth(stats) - 1 < 16;
    })) level++;

    if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
    for (let a = start; a < start + visible; a++) {
      const row = rows[a];
      const bullet = this.bullet(a + 1, sel, theme);
      lines.push(row.kind === "graphRun"
        ? formatFleetGraphRunRow(bullet, a + 1 === sel, row.graphRun, width, theme, undefined, level < 4)
        : rightAlign(`  ${bullet} ${this.agentRowPrefix(row.record, branches.get(row.record.id) ?? "", theme)}${row.record.description}`,
          this.agentRowStats(row.record, level, theme), width));
    }
    if (hiddenBelow > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));
    if (queued > 0) lines.push(truncateToWidth(theme.fg("dim", `    ◦ ${queued} queued`), width));

    return lines;
  }

  private bullet(rosterIndex: number, sel: number, theme: Theme): string {
    return rosterIndex === sel ? theme.fg("accent", "●") : theme.fg("dim", "○");
  }

  private agentRowPrefix(record: AgentRecord, branch: string, theme: Theme): string {
    const mark = statusMark(record);
    const glyph = record.status === "running" ? SPINNER[this.frame] : mark.glyph;
    return branch + theme.fg(mark.color, glyph) + " " + theme.fg("muted", getDisplayName(record.type)) + "  ";
  }

  private agentRowStats(record: AgentRecord, level: number, theme: Theme): string {
    const activity = this.agentActivity.get(record.id);
    const stats: string[] = [];
    const dim = (text: string) => theme.fg("dim", text);
    if (record.status !== "running") stats.push(theme.fg(statusMark(record).color, agentStatusWord(record.status, true)));
    if (record.isBackground === true) stats.push(dim("bg"));
    if (level < 3) {
      const session = record.session;
      const model = session?.model?.id ?? record.invocation?.modelName?.replace(/^[^/]+\//, "");
      const thinking = session?.thinkingLevel ?? record.invocation?.thinking;
      const fast = session ? getSessionFast(session) : record.invocation?.fast;
      if (model) stats.push(dim(`${model}${thinking !== undefined ? `:${thinking}` : ""}${fast === true ? ":fast" : ""}`));
      if (thinking === undefined && record.invocation?.thinkingDefault) stats.push(dim("thinking: default (pending)"));
    }
    if (level < 2) {
      if (activity) stats.push(dim(formatTurns(activity.turnCount, activity.maxTurns)));
      if (record.compactionCount > 0) stats.push(dim(`⇲${record.compactionCount}`));
    }
    if (level < 1) stats.push(dim(`${activity?.toolUses ?? record.toolUses} tools`));
    const tokens = getLifetimeTotal(activity?.lifetimeUsage ?? record.lifetimeUsage);
    const percent = level < 4 ? getSessionContextPercent(activity?.session) : null;
    const context = percent === null ? "" : theme.fg(percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim", ` (${Math.round(percent)}%)`);
    stats.push(dim(formatFleetTokens(tokens)) + context);
    stats.push(dim(formatFleetElapsed((record.completedAt ?? Date.now()) - record.startedAt)));
    return stats.join(dim(" · "));
  }
}
