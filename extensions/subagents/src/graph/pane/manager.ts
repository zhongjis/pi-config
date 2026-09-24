/**
 * manager.ts — the thin coordinator the extension wires into its lifecycle.
 *
 * It owns a {@link GraphRunPaneController}, a debounced writer, and a 1s liveness
 * tick that refreshes elapsed time while a run is live. When there is no
 * Herdr-managed pane to split off it is a strict no-op: it holds no controller,
 * touches no filesystem, and never calls `pi.exec`, so the existing in-Pi overlay
 * is the only inspector on that path.
 *
 * `sync()` is called from every place a run's state changes; it picks the run to
 * show (newest live, else newest overall), makes sure the pane is up unless the
 * user closed it, and drops a fresh snapshot into the state directory for the
 * viewer to paint.
 */

import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { type GraphRunDialogSource, type GraphRunDialogState, initialGraphRunDialogState } from "../../ui/graph-run-dialog.js";
import { initialPanelState, type PanelRun, type PanelState } from "../../ui/observability-panel.js";
import type { GraphRun } from "../history-view.js";
import {
  GraphRunPaneController,
  type PaneExec,
} from "./controller.js";
import {
  applyObservabilityPaneKey,
  applyPaneKey,
  renderGraphRunPaneLines,
  renderObservabilityPaneLines,
  toPaneSource,
  toPanelRun,
} from "./render.js";
import { paneDirFor, readInput, readRecord, readViewport, writeSnapshotAtomic } from "./store.js";

/** Fallback width before the viewer has reported its terminal size. */
const DEFAULT_WIDTH = 80;
/** Coalesce the storm of progress updates a fan-out produces into one write. */
const SYNC_DEBOUNCE_MS = 120;
/** Refresh cadence while a run is live, so elapsed time and status keep moving. */
const LIVENESS_TICK_MS = 1_000;

export interface GraphRunPaneManagerOptions {
  enabled: boolean;
  exec: PaneExec;
  parentPaneId: string;
  socket: string;
  cwd: string;
  sessionId: string;
  ppid: number;
  /** Live runs, read on every sync rather than snapshotted. */
  getTasks: () => Iterable<GraphRun>;
  onError?: (err: unknown, label: string) => void;
  /** Overridable for tests; defaults to the sibling `viewer.mjs`. */
  viewerPath?: string;
  /** Overridable for tests; defaults to the per-pane {@link paneDirFor} directory. */
  dir?: string;
  /** Open the selected node's conversation overlay in the main Pi TUI (wired by the extension). */
  viewAgentConversation?: (recordId: string) => void | Promise<void>;
}

export class GraphRunPaneManager {
  private readonly enabled: boolean;
  private readonly getTasks: () => Iterable<GraphRun>;
  private readonly onError: (err: unknown, label: string) => void;
  private readonly dir: string;
  private readonly sessionId: string;
  private readonly controller: GraphRunPaneController | undefined;

  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private tick: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  /** Serialise sync bodies so a debounced write and a tick cannot race a split. */
  private inFlight = false;
  private again = false;
  /** The observability panel's view state, driven by forwarded keys. See `applyObservabilityPaneKey`. */
  private panelState: PanelState = initialPanelState();
  /** The run the user pinned with `←/→`; unset means follow the last-active run. */
  private pinnedRunId: string | undefined;
  /** The run the panel last rendered, so a switch resets node selection and scroll. */
  private lastPanelRunId: string | undefined;
  /** The roster view state, kept for the on-throw fallback render. See `applyPaneKey`. */
  private paneState: GraphRunDialogState = initialGraphRunDialogState();
  /** Highest input sequence already applied, so each keystroke lands once. */
  private lastInputSeq = 0;
  /** The run currently shown, so switching runs resets the view to the overview. */
  private lastShownTaskId: string | undefined;
  private inputWatcher: FSWatcher | undefined;
  /** Opens the selected node's conversation overlay; called on the `c` key. */
  private readonly viewAgentConversation: ((recordId: string) => void | Promise<void>) | undefined;

  constructor(options: GraphRunPaneManagerOptions) {
    this.enabled = options.enabled;
    this.getTasks = options.getTasks;
    this.onError = options.onError ?? (() => {});
    this.sessionId = options.sessionId;
    this.viewAgentConversation = options.viewAgentConversation;

    if (!this.enabled) {
      // Strict no-op: never resolve a directory, a viewer path, or a controller.
      this.dir = "";
      this.controller = undefined;
      return;
    }

    this.dir = options.dir ?? paneDirFor(options.sessionId, options.parentPaneId, options.socket);
    const viewerPath = options.viewerPath ?? fileURLToPath(new URL("./viewer.mjs", import.meta.url));
    this.controller = new GraphRunPaneController({
      exec: options.exec,
      dir: this.dir,
      parentPaneId: options.parentPaneId,
      cwd: options.cwd,
      sessionId: options.sessionId,
      viewerPath,
      ppid: options.ppid,
    });
    this.startInputWatch();
  }

  /**
   * Watch the pane directory for forwarded keys. fs.watch fires for every file
   * in the dir (state.json/viewport.json writes included); the sequence guard in
   * {@link processInputFile} makes those firings harmless.
   */
  private startInputWatch(): void {
    if (!this.enabled || this.inputWatcher || this.disposed) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      // The persisted slot predates this manager; do not replay it on directory events.
      this.lastInputSeq = readInput(this.dir)?.seq ?? 0;
      this.inputWatcher = watch(this.dir, () => void this.processInputFile());
    } catch (err) {
      this.onError(err, "graph run pane input watch");
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Adopt a still-alive owned pane or clear a stale record. See the controller. */
  async reconcile(): Promise<void> {
    if (!this.enabled || !this.controller) return;
    try {
      await this.controller.reconcile();
    } catch (err) {
      this.onError(err, "graph run pane reconcile");
    }
  }

  /**
   * Refresh the pane for the current run. Debounced, and it also starts or stops
   * the liveness tick depending on whether anything is still running.
   */
  sync(): void {
    if (!this.enabled || this.disposed) return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      void this.runSync(false);
    }, SYNC_DEBOUNCE_MS);
    this.updateTick();
  }

  /**
   * Reopen the pane for the active run, overriding a manual close. Returns false
   * when there is no Herdr pane to open, so the caller can explain why.
   */
  async forceOpen(runId?: string): Promise<boolean> {
    if (!this.enabled || this.disposed) return false;
    if (runId !== undefined) this.pinnedRunId = runId;
    await this.runSync(true);
    this.updateTick();
    return true;
  }

  /** Close the pane we created and stop all timers. */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = undefined;
    }
    if (this.tick) {
      clearInterval(this.tick);
      this.tick = undefined;
    }
    if (this.inputWatcher) {
      try {
        this.inputWatcher.close();
      } catch {
        // Already closed or never opened.
      }
      this.inputWatcher = undefined;
    }
    if (!this.enabled || !this.controller) return;
    try {
      await this.controller.closeOwned();
    } catch (err) {
      this.onError(err, "graph run pane close");
    }
  }

  private pickTask(): GraphRun | undefined {
    const tasks = [...this.getTasks()];
    if (tasks.length === 0) return undefined;
    const live = tasks.filter(task => task.status === "running" || task.status === "paused");
    const pool = live.length > 0 ? live : tasks;
    return pool.reduce((newest, task) => (task.startTime > newest.startTime ? task : newest));
  }

  /**
   * Pick the run to show and reset the view when it changes. A stale phase/agent
   * index from a previous run must not carry over into a new one.
   */
  private pickAndTrack(): GraphRun | undefined {
    const task = this.pickTask();
    if (task?.id !== this.lastShownTaskId) {
      this.paneState = initialGraphRunDialogState();
      this.lastShownTaskId = task?.id;
    }
    return task;
  }

  /** All runs this session has seen, newest first — the switcher's run list order. */
  private sortedTasks(): GraphRun[] {
    return [...this.getTasks()].sort((a, b) => b.startTime - a.startTime);
  }

  private toRuns(tasks: readonly GraphRun[]): PanelRun[] {
    return tasks.map(toPanelRun);
  }

  /**
   * Which run the switcher points at: the pinned run if it still exists, else the
   * last-active run (the `pickTask` rule). A vanished pin falls back to last-active.
   * Resets the panel's node selection, scroll, and stage collapse when the shown run
   * changes, but keeps the filter (a persistent user intent, not per-graph).
   */
  private resolveRunIndex(tasks: readonly GraphRun[]): number {
    if (tasks.length === 0) return 0;
    let index = -1;
    if (this.pinnedRunId !== undefined) {
      index = tasks.findIndex(task => task.id === this.pinnedRunId);
      if (index < 0) this.pinnedRunId = undefined;
    }
    if (index < 0) {
      const active = this.pickTask();
      index = active ? tasks.findIndex(task => task.id === active.id) : -1;
      if (index < 0) index = 0;
    }
    const shownId = tasks[index]?.id;
    if (shownId !== this.lastPanelRunId) {
      this.panelState.cursor = undefined;
      this.panelState.scroll = 0;
      // Stages differ per graph; keep the user's filter intent across the switch.
      this.panelState.collapsedStages = [];
      this.panelState.collapsedTargets = [];
      this.lastPanelRunId = shownId;
    }
    return index;
  }

  /** Render the panel, falling back to the roster render if the panel ever throws. */
  private renderPanelOrRoster(tasks: readonly GraphRun[], width: number, rows: number | undefined): string[] {
    const runs = this.toRuns(tasks);
    const index = this.resolveRunIndex(tasks);
    this.panelState.runIndex = index;
    try {
      return renderObservabilityPaneLines(runs, this.panelState, { width, rows });
    } catch {
      const task = tasks[index] ?? tasks[0];
      return renderGraphRunPaneLines(toPaneSource(task), { width, state: this.paneState, rows });
    }
  }

  /** Apply a key through the panel, falling back to the roster handler if it throws. */
  private applyPanelOrRosterKey(
    tasks: readonly GraphRun[], data: string, width: number, rows: number | undefined,
  ): { lines: string[]; close: boolean } {
    const runs = this.toRuns(tasks);
    const index = this.resolveRunIndex(tasks);
    this.panelState.runIndex = index;
    try {
      const result = applyObservabilityPaneKey(runs, this.panelState, data, { width, rows });
      this.panelState = result.state;
      if (this.panelState.runIndex !== index) {
        this.pinnedRunId = runs[this.panelState.runIndex]?.id;
        this.lastPanelRunId = this.pinnedRunId;
      }
      // `c` opens the selected node's conversation in the main TUI. Not a close: still paint a snapshot.
      if (result.action?.kind === "open") void this.viewAgentConversation?.(result.action.recordId);
      return { lines: result.lines, close: result.close };
    } catch {
      const task = tasks[index];
      const source: GraphRunDialogSource = task
        ? toPaneSource(task)
        : { progress: [], task: { status: "completed", startTime: 0 }, agentCount: 0 };
      const result = applyPaneKey(source, this.paneState, data, { width, rows });
      this.paneState = result.state;
      return { lines: result.lines, close: result.close };
    }
  }

  /**
   * Apply the latest forwarded keystroke, if newer than the last one applied, and
   * write the resulting snapshot immediately (not debounced) for responsiveness.
   */
  private async processInputFile(): Promise<void> {
    if (!this.enabled || this.disposed) return;
    const input = readInput(this.dir);
    if (!input || input.seq <= this.lastInputSeq) return;
    this.lastInputSeq = input.seq;
    // Keep the roster fallback's view state fresh (paneState reset + lastShownTaskId).
    this.pickAndTrack();
    let data: string;
    try {
      data = Buffer.from(input.data, "base64").toString("utf8");
    } catch {
      return; // Undecodable chunk; drop it.
    }
    try {
      const vp = readViewport(this.dir);
      const width = vp?.cols ?? DEFAULT_WIDTH;
      const rows = vp?.rows;
      const { lines, close } = this.applyPanelOrRosterKey(this.sortedTasks(), data, width, rows);
      // esc/q at the top level is the pane's one honoured action: a real,
      // user-initiated close. Do not paint a fresh snapshot after it.
      if (close) {
        await this.controller?.closeForUser();
        return;
      }
      writeSnapshotAtomic(this.dir, {
        version: 1,
        sessionId: this.sessionId,
        updatedAt: Date.now(),
        connected: true,
        lines,
      });
    } catch (err) {
      this.onError(err, "graph run pane input");
    }
  }

  private hasLiveTask(): boolean {
    for (const task of this.getTasks()) {
      if (task.status === "running" || task.status === "paused") return true;
    }
    return false;
  }

  private updateTick(): void {
    if (this.disposed) return;
    const live = this.hasLiveTask();
    if (live && this.tick === undefined) {
      this.tick = setInterval(() => {
        void this.runSync(false);
      }, LIVENESS_TICK_MS);
      // Do not keep the process alive for the pane alone.
      this.tick.unref?.();
    } else if (!live && this.tick !== undefined) {
      clearInterval(this.tick);
      this.tick = undefined;
    }
  }

  /** Coalescing wrapper: while one sync runs, remember that another was asked for. */
  private async runSync(force: boolean): Promise<void> {
    if (this.inFlight) {
      this.again = this.again || force;
      return;
    }
    this.inFlight = true;
    try {
      await this.syncNow(force);
    } finally {
      this.inFlight = false;
      if (this.again) {
        this.again = false;
        void this.runSync(false);
      }
    }
  }

  private async syncNow(force: boolean): Promise<void> {
    if (!this.enabled || !this.controller || this.disposed) return;
    // Keep the roster fallback's view state fresh (paneState reset + lastShownTaskId).
    this.pickAndTrack();

    try {
      // Auto-open only once a run exists this session; a forced open (a detach (`o`))
      // still opens on demand. Keeps an empty pane from appearing at session start.
      if (force) {
        await this.controller.ensurePane(true);
      } else if (this.pickTask() !== undefined && !readRecord(this.dir)?.closedByUser) {
        await this.controller.ensurePane(false);
      }
    } catch (err) {
      this.onError(err, "graph run pane");
    }

    try {
      const vp = readViewport(this.dir);
      const width = vp?.cols ?? DEFAULT_WIDTH;
      const rows = vp?.rows;
      const tasks = this.sortedTasks();
      const lines = tasks.length > 0
        ? this.renderPanelOrRoster(tasks, width, rows)
        : ["", "  No graph runs in this session yet."];
      writeSnapshotAtomic(this.dir, {
        version: 1,
        sessionId: this.sessionId,
        updatedAt: Date.now(),
        connected: true,
        lines,
      });
    } catch (err) {
      this.onError(err, "graph run pane snapshot");
    }
  }
}

export function createGraphRunPaneManager(options: GraphRunPaneManagerOptions): GraphRunPaneManager {
  return new GraphRunPaneManager(options);
}
