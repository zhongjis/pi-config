/**
 * manager.ts — the thin coordinator the extension wires into its lifecycle.
 *
 * It owns a {@link WorkflowPaneController}, a debounced writer, and a 1s liveness
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
import { initialWorkflowDialogState, type WorkflowDialogSource, type WorkflowDialogState } from "../../ui/workflow-dialog.js";
import type { WorkflowTask } from "../task.js";
import {
  type PaneExec,
  WorkflowPaneController,
} from "./controller.js";
import { applyPaneKey, renderWorkflowPaneLines, toPaneSource } from "./render.js";
import { paneDirFor, readInput, readRecord, readViewport, writeSnapshotAtomic } from "./store.js";

/** Fallback width before the viewer has reported its terminal size. */
const DEFAULT_WIDTH = 80;
/** Coalesce the storm of progress updates a fan-out produces into one write. */
const SYNC_DEBOUNCE_MS = 120;
/** Refresh cadence while a run is live, so elapsed time and status keep moving. */
const LIVENESS_TICK_MS = 1_000;

export interface WorkflowPaneManagerOptions {
  enabled: boolean;
  exec: PaneExec;
  parentPaneId: string;
  socket: string;
  cwd: string;
  sessionId: string;
  ppid: number;
  /** Live runs, read on every sync rather than snapshotted. */
  getTasks: () => Iterable<WorkflowTask>;
  onError?: (err: unknown, label: string) => void;
  /** Overridable for tests; defaults to the sibling `viewer.mjs`. */
  viewerPath?: string;
  /** Overridable for tests; defaults to the per-pane {@link paneDirFor} directory. */
  dir?: string;
}

export class WorkflowPaneManager {
  private readonly enabled: boolean;
  private readonly getTasks: () => Iterable<WorkflowTask>;
  private readonly onError: (err: unknown, label: string) => void;
  private readonly dir: string;
  private readonly sessionId: string;
  private readonly controller: WorkflowPaneController | undefined;

  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private tick: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  /** Serialise sync bodies so a debounced write and a tick cannot race a split. */
  private inFlight = false;
  private again = false;
  /** The pane's own view state, driven by forwarded keys. See `applyPaneKey`. */
  private paneState: WorkflowDialogState = initialWorkflowDialogState();
  /** Highest input sequence already applied, so each keystroke lands once. */
  private lastInputSeq = 0;
  /** The run currently shown, so switching runs resets the view to the overview. */
  private lastShownTaskId: string | undefined;
  private inputWatcher: FSWatcher | undefined;

  constructor(options: WorkflowPaneManagerOptions) {
    this.enabled = options.enabled;
    this.getTasks = options.getTasks;
    this.onError = options.onError ?? (() => {});
    this.sessionId = options.sessionId;

    if (!this.enabled) {
      // Strict no-op: never resolve a directory, a viewer path, or a controller.
      this.dir = "";
      this.controller = undefined;
      return;
    }

    this.dir = options.dir ?? paneDirFor(options.sessionId, options.parentPaneId, options.socket);
    const viewerPath = options.viewerPath ?? fileURLToPath(new URL("./viewer.mjs", import.meta.url));
    this.controller = new WorkflowPaneController({
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
      this.inputWatcher = watch(this.dir, () => void this.processInputFile());
    } catch (err) {
      this.onError(err, "workflow pane input watch");
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
      this.onError(err, "workflow pane reconcile");
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
  async forceOpen(): Promise<boolean> {
    if (!this.enabled || this.disposed) return false;
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
      this.onError(err, "workflow pane close");
    }
  }

  private pickTask(): WorkflowTask | undefined {
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
  private pickAndTrack(): WorkflowTask | undefined {
    const task = this.pickTask();
    if (task?.id !== this.lastShownTaskId) {
      this.paneState = initialWorkflowDialogState();
      this.lastShownTaskId = task?.id;
    }
    return task;
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
    // Track the shown run so a switch resets the view; when there is no run an
    // empty source still lets esc close the pane.
    const task = this.pickAndTrack();
    let data: string;
    try {
      data = Buffer.from(input.data, "base64").toString("utf8");
    } catch {
      return; // Undecodable chunk; drop it.
    }
    try {
      const width = readViewport(this.dir)?.cols ?? DEFAULT_WIDTH;
      const source: WorkflowDialogSource = task
        ? toPaneSource(task)
        : { progress: [], task: { status: "completed", startTime: 0 }, agentCount: 0 };
      const { state, lines, close } = applyPaneKey(source, this.paneState, data, { width });
      this.paneState = state;
      // esc/q at the overview level is the pane's one honoured action: a real,
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
      this.onError(err, "workflow pane input");
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
    const task = this.pickAndTrack();

    try {
      if (force) {
        await this.controller.ensurePane(true);
      } else if (!readRecord(this.dir)?.closedByUser) {
        await this.controller.ensurePane(false);
      }
    } catch (err) {
      this.onError(err, "workflow pane");
    }

    try {
      const width = readViewport(this.dir)?.cols ?? DEFAULT_WIDTH;
      const lines = task
        ? renderWorkflowPaneLines(toPaneSource(task), { width, state: this.paneState })
        : ["", "  No workflow runs in this session yet."];
      writeSnapshotAtomic(this.dir, {
        version: 1,
        sessionId: this.sessionId,
        updatedAt: Date.now(),
        connected: true,
        lines,
      });
    } catch (err) {
      this.onError(err, "workflow pane snapshot");
    }
  }
}

export function createWorkflowPaneManager(options: WorkflowPaneManagerOptions): WorkflowPaneManager {
  return new WorkflowPaneManager(options);
}
