/**
 * advance-task-graph.ts — the pure decision core for DAG advancement.
 *
 * When a subagent settles (`subagents:completed` / `subagents:failed`), the task
 * graph must advance: finalize the owning task, and — on completion with
 * auto-cascade enabled — spawn the now-unblocked downstream tasks. That decision
 * used to live inside an event-listener closure that mutated `agentTaskMap`, the
 * store, the widget, and the auto-clear manager in place, making it untestable
 * without the whole live runtime.
 *
 * `advanceTaskGraph(event, snapshot)` takes the settle event plus a read-only
 * snapshot of the graph and returns the effects as data — a `Command[]`. The
 * event listeners become thin appliers (see apply-commands.ts). The emitted
 * command ORDER is part of the behavior contract and is preserved exactly.
 */

import type { Task } from "../types.js";
import type { TaskUpdateFields } from "./fsm-dispatch.js";

/** Cascade parameters carried forward from the originating TaskExecute call. */
export type CascadeConfig = { additionalContext?: string; model?: string; maxTurns?: number };

/** A subagent settle event that may advance the graph. */
export type GraphEvent =
  | { kind: "completed"; agentId: string; result?: string }
  | { kind: "failed"; agentId: string; error?: string; result?: string; status: string };

/** Read-only view of the graph at the moment an event is handled. */
export interface GraphSnapshot {
  tasks: readonly Task[];
  agentToTask: ReadonlyMap<string, string>;
  /** Present only when auto-cascade is enabled AND ready (cascadeConfig + latestCtx). */
  cascade?: CascadeConfig;
}

/** An effect to apply, as data. All store writes use the "internal" transition source. */
export type Command =
  | { kind: "deleteAgentMapping"; agentId: string }
  | { kind: "updateTask"; taskId: string; fields: TaskUpdateFields }
  | { kind: "setActiveTask"; taskId: string; active: boolean }
  | { kind: "trackCompletion"; taskId: string }
  | { kind: "resetBatchCountdown" }
  | {
      kind: "spawnTask";
      taskId: string;
      agentType: string;
      additionalContext?: string;
      spawnOptions: Record<string, unknown>;
    }
  | { kind: "widgetUpdate" };

/** Tasks that become runnable once `completedId` is treated as completed. */
function unblockedBy(completedId: string, tasks: readonly Task[]): Task[] {
  return tasks.filter(
    (t) =>
      t.status === "pending" &&
      t.metadata?.agentType &&
      t.blockedBy.includes(completedId) &&
      t.blockedBy.every((depId) =>
        depId === completedId ? true : tasks.find((d) => d.id === depId)?.status === "completed",
      ),
  );
}

/**
 * Decide how the task graph advances in response to a subagent settle event.
 * Pure: no I/O, no mutation. Returns the effects as an ordered `Command[]`.
 */
export function advanceTaskGraph(event: GraphEvent, snapshot: GraphSnapshot): Command[] {
  const taskId = snapshot.agentToTask.get(event.agentId);
  // Unknown agent — not one of ours. Match the listener's early return before delete.
  if (taskId === undefined) return [];

  const commands: Command[] = [{ kind: "deleteAgentMapping", agentId: event.agentId }];

  const task = snapshot.tasks.find((t) => t.id === taskId);
  if (!task) return commands; // mapping retired; task already gone.

  if (event.kind === "completed") {
    commands.push({
      kind: "updateTask",
      taskId: task.id,
      fields: { status: "completed", metadata: { ...task.metadata, result: event.result } },
    });
    commands.push({ kind: "setActiveTask", taskId: task.id, active: false });

    if (snapshot.cascade) {
      for (const next of unblockedBy(task.id, snapshot.tasks)) {
        commands.push({ kind: "updateTask", taskId: next.id, fields: { status: "in_progress" } });
        commands.push({
          kind: "spawnTask",
          taskId: next.id,
          agentType: next.metadata.agentType,
          additionalContext: snapshot.cascade.additionalContext,
          spawnOptions: {
            description: next.subject,
            isBackground: true,
            maxTurns: snapshot.cascade.maxTurns,
            ...(snapshot.cascade.model ? { model: snapshot.cascade.model } : {}),
          },
        });
      }
    }

    commands.push({ kind: "trackCompletion", taskId: task.id });
    commands.push({ kind: "widgetUpdate" });
    return commands;
  }

  // event.kind === "failed"
  if (event.status === "stopped") {
    if (task.status === "completed") {
      // Late stopped event after a manual TaskStop already finalized the task:
      // backfill the partial result if we now have one, but don't re-track or re-render.
      if (event.result && !task.metadata?.result) {
        commands.push({
          kind: "updateTask",
          taskId: task.id,
          fields: { metadata: { ...task.metadata, result: event.result } },
        });
      }
      return commands;
    }
    commands.push({
      kind: "updateTask",
      taskId: task.id,
      fields: { status: "completed", metadata: { ...task.metadata, result: event.result || task.metadata?.result } },
    });
    commands.push({ kind: "trackCompletion", taskId: task.id });
  } else {
    commands.push({
      kind: "updateTask",
      taskId: task.id,
      fields: { status: "pending", metadata: { ...task.metadata, lastError: event.error || event.status } },
    });
    commands.push({ kind: "resetBatchCountdown" });
  }

  commands.push({ kind: "setActiveTask", taskId: task.id, active: false });
  commands.push({ kind: "widgetUpdate" });
  return commands;
}
