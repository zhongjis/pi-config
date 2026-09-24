/**
 * graph-run-types.ts — shared value types for the run monitor.
 *
 * The typed graph runtime, the background task record and the UI all read these:
 * a run's live control surface, its settled result, and the up-front `meta` the
 * monitor renders phases from. Kept in their own module so no consumer has to
 * import an engine just to name one of its types.
 */

import type { GraphRunOutcome } from "./outcome.js";
import type { GraphRunEntry } from "./progress.js";

/** A phase declared up front, so the UI can show it before any agent runs. */
export interface GraphRunPhaseMeta {
  title: string;
  detail?: string;
  /** Set when a phase pins a model; display-only, the runtime does not read it. */
  model?: string;
}

export interface GraphRunMeta {
  name: string;
  description: string;
  /** Shown in the saved-workflow listing. Not used by the runtime. */
  whenToUse?: string;
  phases?: GraphRunPhaseMeta[];
  inputSchema?: Record<string, unknown>;
}

/**
 * What a run can be told to do while it is going, from the workflows dialog.
 *
 * Every method is best-effort and idempotent: the dialog renders off a progress
 * log that lags the runtime slightly, so it will sometimes ask for something
 * that has just stopped being possible. `false` means "there was nothing to do
 * that to" — a caller can say so, but it is never an error.
 */
export interface GraphRunControl {
  /**
   * Stop *starting* agents. Ones already running are left to finish, because
   * killing model work mid-turn throws away everything it has spent and there
   * is no way to hand it back its context.
   */
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  /**
   * Give up on the agent at `index`: its `agent()` call returns `null`, exactly
   * for required and optional calls alike, and the row renders skipped.
   *
   * Immediate for a running agent and for one held at a pause. An agent parked
   * behind the concurrency limit takes its skip when it reaches the front —
   * the alternative is a cancellable semaphore for a case that resolves itself
   * as soon as any sibling finishes.
   */
  skip(index: number): boolean;
  /**
   * Start the agent at `index` over: the child is stopped and the same call is
   * re-run, so the script's `agent()` promise is still the one waiting and it
   * gets the new answer.
   *
   * Only while it is running — that is the whole window. Once the call has
   * settled its value is already the script's, and re-running would produce a
   * result with nowhere to go.
   */
  retry(index: number): boolean;
}

export interface GraphRunResult {
  status: "completed" | "failed" | "killed";
  meta: GraphRunMeta;
  outcome?: GraphRunOutcome;
  /** The run's return value, JSON-checked at the boundary. */
  value?: unknown;
  error?: string;
  /** The append-only log, in emission order. */
  progress: GraphRunEntry[];
  /** Agents scheduled, including those that failed. */
  agentCount: number;
  /** How many of those came back from a journal instead of being spawned. */
  replayedCount: number;
}
