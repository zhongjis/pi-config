/**
 * task.ts — the background record one workflow run lives in.
 *
 * An `agent_graph` tool call returns a task id immediately and the run continues
 * without it, so the run's state cannot live in the tool call's closure: the
 * inline card, the completion notification and (later) the `/agents → Workflows` dialog
 * all read it after `execute` has returned. This is that record, shaped after
 * Claude Code's `local_workflow` task so the fields line up with what the
 * renderers already expect.
 *
 * The progress log is append-only and collapses by index (see `progress.ts`),
 * so every derived counter here is recomputed from the log rather than
 * incremented as entries arrive — a re-emitted agent entry replaces its
 * predecessor, and adding its tokens on top would double-count them.
 */

import { randomUUID } from "node:crypto";
import { WORKFLOW_RESULT_PREVIEW_CHARS } from "../constants.js";
import type { GraphRunControl, GraphRunMeta, GraphRunResult } from "./graph-run-types.js";
import { outcomeLabel, type WorkflowOutcome } from "./outcome.js";
import { collapse, elapsedMs, type GraphRunEntry, type GraphRunStatus, stats } from "./progress.js";

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** `wf_` + hex, matching Claude Code's `^wf_[a-z0-9-]{6,}$` run ids. */
export function workflowRunId(): string {
  return `wf_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export interface GraphRunTask {
  /** Discriminator, alongside Claude Code's `local_agent` / `local_bash`. */
  type: "local_workflow";
  id: string;
  status: GraphRunStatus;
  script: string;
  /** Where the script can be edited and re-run from. */
  scriptPath?: string;
  /** Presentation facts set only by the existing completion artifact writer. */
  resultPath?: string;
  resultArtifactError?: string;
  args?: unknown;
  meta?: GraphRunMeta;
  graphRunName?: string;
  /** The `tool_use_id` of the call that started this, when one did. */
  toolCallId?: string;

  /**
   * Pause, skip and retry, once the run is up.
   *
   * Absent before the runtime hands it over and after the run settles — the
   * dialog treats "no control" as "those keys do nothing", which is the same
   * thing it does for a run that has finished.
   */
  control?: GraphRunControl;
  /** When the current pause started, so `totalPausedMs` can be closed out. */
  pausedAt?: number;

  /** Where this run records its own settled calls, for a later resume. */
  journalPath?: string;
  /** The run id this one resumed, for the result line that says so. */
  resumedFrom?: string;
  /** How many agents were restored from an earlier run instead of being spawned. */
  replayedCount: number;

  /** The append-only event log, in emission order. */
  graphRunProgress: GraphRunEntry[];
  /** Bumped once per applied batch, so a renderer can tell nothing changed. */
  progressVersion: number;
  agentCount: number;
  /**
   * Agents that have settled successfully, recomputed with the other counters.
   *
   * Cached rather than derived on read because the fleet list asks five times a
   * second: deriving it there would walk the whole append-only log on every
   * tick, which for a thousand-agent run is real work in the render loop.
   */
  doneCount: number;
  totalTokens: number;
  totalToolCalls: number;
  logs: string[];

  abortController: AbortController;
  startTime: number;
  endTime?: number;
  /** Excluded from the elapsed clock the header shows. */
  totalPausedMs: number;

  /** The script's return value, once the run produced one. */
  value?: unknown;
  outcome?: WorkflowOutcome;
  error?: string;
}

export function createGraphRunTask(init: {
  id: string;
  script: string;
  scriptPath?: string;
  args?: unknown;
  meta?: GraphRunMeta;
  toolCallId?: string;
  startTime?: number;
  journalPath?: string;
  resumedFrom?: string;
}): GraphRunTask {
  return {
    type: "local_workflow",
    id: init.id,
    status: "running",
    script: init.script,
    scriptPath: init.scriptPath,
    args: init.args,
    meta: init.meta,
    graphRunName: init.meta?.name,
    toolCallId: init.toolCallId,
    journalPath: init.journalPath,
    resumedFrom: init.resumedFrom,
    replayedCount: 0,
    graphRunProgress: [],
    progressVersion: 0,
    agentCount: 0,
    doneCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    logs: [],
    abortController: new AbortController(),
    startTime: init.startTime ?? Date.now(),
    totalPausedMs: 0,
  };
}

/**
 * Apply one batch of progress entries.
 *
 * Batched rather than per-entry because that is how the worker emits them, and
 * because every counter below is an O(log) recompute — doing it once per fan-out
 * frame instead of once per agent is the difference that keeps a 200-agent run
 * cheap to render.
 */
export function updateGraphRunProgressBatch(
  task: GraphRunTask,
  entries: readonly GraphRunEntry[],
): void {
  if (entries.length === 0) return;
  task.graphRunProgress.push(...entries);
  task.progressVersion++;

  const { agents, logs } = collapse(task.graphRunProgress);
  task.logs = logs;
  // `agentCount` is what the runtime has scheduled, which can lead what the log
  // has seen — never let a recompute walk it backwards.
  task.agentCount = Math.max(task.agentCount, agents.length);

  let totalTokens = 0;
  let totalToolCalls = 0;
  let done = 0;
  for (const agent of agents) {
    totalTokens += agent.tokens ?? 0;
    totalToolCalls += agent.toolCalls ?? 0;
    // Counted off the collapsed agents, so a re-emitted row counts once.
    if (agent.state === "done") done++;
  }
  task.totalTokens = totalTokens;
  task.totalToolCalls = totalToolCalls;
  task.doneCount = done;
}

/**
 * Hold the run, and stop its clock.
 *
 * The elapsed figure every surface shows subtracts `totalPausedMs`, so a run
 * left paused overnight does not come back reading as a twelve-hour run.
 */
export function pauseGraphRunTask(task: GraphRunTask, now = Date.now()): boolean {
  if (task.status !== "running" || task.control === undefined) return false;
  task.control.pause();
  task.status = "paused";
  task.pausedAt = now;
  return true;
}

/** Let it go again, banking however long it was held. */
export function resumeGraphRunTask(task: GraphRunTask, now = Date.now()): boolean {
  if (task.status !== "paused" || task.control === undefined) return false;
  task.control.resume();
  task.status = "running";
  task.totalPausedMs = (task.totalPausedMs ?? 0) + Math.max(0, now - (task.pausedAt ?? now));
  task.pausedAt = undefined;
  return true;
}

/** Settle a task from the run's own result. */
export function completeGraphRunTask(task: GraphRunTask, result: GraphRunResult): void {
  // Banked before the status moves off "paused": a run that finished while held
  // still spent that time held, and the elapsed figure has to say so.
  if (task.pausedAt !== undefined) {
    task.totalPausedMs = (task.totalPausedMs ?? 0) + Math.max(0, Date.now() - task.pausedAt);
    task.pausedAt = undefined;
  }
  // Nothing left to control, and holding the handle would let the dialog offer
  // pause on a run that has already stopped.
  task.control = undefined;
  task.status = result.status;
  task.meta ??= result.meta;
  task.graphRunName ??= result.meta.name;
  task.agentCount = Math.max(task.agentCount, result.agentCount);
  task.replayedCount = result.replayedCount;
  task.value = result.value;
  task.outcome = result.outcome;
  task.error = result.error;
  task.endTime = Date.now();
}

/**
 * Settle a task that never produced a result — a script rejected before the
 * worker started (bad `meta`, oversized source, non-JSON `args`).
 */
export function failGraphRunTask(task: GraphRunTask, error: string): void {
  task.control = undefined;
  task.pausedAt = undefined;
  task.status = "failed";
  task.error = error;
  task.endTime = Date.now();
}

/** The run's result body; `space` controls object indentation (pretty for the artifact, compact for previews). */
function graphRunResultBody(task: GraphRunTask, space?: number): string {
  if (task.error !== undefined) return task.error;
  if (task.value === undefined) return "No output.";
  if (typeof task.value === "string") return task.value;
  return JSON.stringify(task.value, null, space);
}

/** The COMPLETE run result as text, for the artifact file and the expanded report. */
export function graphRunResultText(task: GraphRunTask): string {
  return graphRunResultBody(task, 2);
}

/**
 * A bounded, model-facing preview of the run result.
 *
 * Prefers a top-level string `summary` field when the value is a plain object, otherwise a
 * compact encoding of the result body. Hard-capped to `cap` characters with a trailing ellipsis
 * when cut, so the completion notification never embeds an unbounded payload — the complete
 * result is written to an artifact and linked instead (see {@link formatGraphRunNotification}).
 */
export function graphRunResultPreview(task: GraphRunTask, cap = WORKFLOW_RESULT_PREVIEW_CHARS): string {
  const summary =
    task.value !== null && typeof task.value === "object" && !Array.isArray(task.value)
      ? (task.value as Record<string, unknown>).summary
      : undefined;
  const base = typeof summary === "string" ? summary : graphRunResultBody(task);
  return base.length > cap ? `${base.slice(0, cap - 1)}…` : base;
}

/**
 * Resolve a `resumeFromRunId` against the runs this session has seen.
 *
 * Same-session only, and deliberately so: the journal lives beside the
 * session's task files, and a run id from another session would silently find
 * nothing to replay — reporting that as "resumed" would be a lie the caller
 * could not see through. An unknown id is an error rather than a cold start,
 * because a caller that asked to resume is expecting not to pay.
 */
export function resolveResumeTarget(
  runId: string | undefined,
  tasks: ReadonlyMap<string, GraphRunTask>,
):
  | undefined
  | { ok: true; runId: string; journalPath: string; scriptPath: string }
  | { ok: false; message: string } {
  const id = runId?.trim();
  if (id === undefined || id === "") return undefined;

  const prior = tasks.get(id);
  if (prior === undefined) {
    const known = [...tasks.keys()];
    return {
      ok: false,
      message:
        `No graph run "${id}" in this session. ` +
        (known.length > 0
          ? `Runs this session: ${known.join(", ")}.`
          : "Nothing has run yet — call this without `resumeFromRunId`."),
    };
  }
  if (prior.status === "running" || prior.status === "paused") {
    return {
      ok: false,
      message: `Graph run "${id}" is ${prior.status}. Stop it from /agents → Graph runs before resuming it.`,
    };
  }
  if (prior.journalPath === undefined) {
    return { ok: false, message: `Graph run "${id}" has no journal to resume from.` };
  }
  return {
    ok: true,
    runId: id,
    journalPath: prior.journalPath,
    // The persisted copy, which is what `scriptPath` holds when the call had
    // no file of its own.
    scriptPath: prior.scriptPath ?? "",
  };
}

/** `<task-notification>`, in the same shape a finished background agent sends. */
export function formatGraphRunNotification(task: GraphRunTask, now = Date.now()): string {
  const totals = stats(task.graphRunProgress, task.agentCount);
  const agents = collapse(task.graphRunProgress).agents;
  const skipped = agents.filter(agent => agent.skipped).length;
  const failed = agents.filter(agent => agent.state === "error" && !agent.skipped).length;
  const status =
    task.status === "completed" ? outcomeLabel(task.outcome)
    : task.status === "killed" ? "Stopped"
    : `Error: ${task.error ?? "unknown"}`;
  // Bounded, model-facing preview. When the full result was written to an artifact, `resultPath`
  // is already set (see graphRunCompletionText) and drives the truncation marker + `<result-file>`.
  const resultPath = task.resultPath;
  const preview = graphRunResultPreview(task);
  const resultBody =
    resultPath !== undefined ? `${preview}\n...(truncated; the complete result is in the linked result file)` : preview;
  return [
    `<task-notification>`,
    `<task-id>${task.id}</task-id>`,
    task.toolCallId ? `<tool-use-id>${escapeXml(task.toolCallId)}</tool-use-id>` : null,
    task.scriptPath ? `<script>${escapeXml(task.scriptPath)}</script>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Graph run "${escapeXml(task.graphRunName ?? task.id)}" — Execution: ${task.status} — ${totals.done}/${totals.total} agents completed, ${failed} failed, ${skipped} skipped${
      task.replayedCount > 0 ? `, ${task.replayedCount} replayed from ${escapeXml(task.resumedFrom ?? "an earlier run")}` : ""
    }</summary>`,
    `<result>${escapeXml(resultBody)}</result>`,
    resultPath !== undefined ? `<result-file>${escapeXml(resultPath)}</result-file>` : null,
    `<usage><total_tokens>${task.totalTokens}</total_tokens><tool_uses>${task.totalToolCalls}</tool_uses><duration_ms>${elapsedMs(task, now)}</duration_ms></usage>`,
    `</task-notification>`,
  ].filter(Boolean).join("\n");
}
