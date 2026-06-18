/**
 * task-runner.ts — the seam between the task tools and the two ways a task runs.
 *
 * A task executes as either a background shell process (pull-based, locally
 * buffered output, killed with SIGTERM/SIGKILL) or a spawned subagent
 * (push-based, result delivered on a `subagents:*` event, killed over RPC).
 * Both models sit behind one `TaskRunner` interface as adapters, so TaskOutput
 * and TaskStop never branch on which model owns a task.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentBridge } from "./bridge/subagent-bridge.js";
import { TASK_OUTPUT_DEFAULT_TIMEOUT_MS, TASK_PROCESS_WAIT_TIMEOUT_MS } from "./constants.js";
import { updateTask } from "./lifecycle/fsm-dispatch.js";
import type { TaskRuntime } from "./lifecycle/store-glue.js";

export interface GetOutputOptions {
  block: boolean;
  timeout: number;
  signal?: AbortSignal;
}

/** Outcome of asking an adapter to stop a task. */
interface StopOutcome {
  /** Whether the adapter acted on a running task. */
  acted: boolean;
  /** Task id whose status the runner should mark completed. */
  completedTaskId?: string;
}

/** One way a task runs, behind the TaskRunner seam. */
export interface TaskExecutionAdapter {
  /** Does this adapter own the task identified by `externalId`? */
  claims(externalId: string): boolean;
  /** Formatted output/status for the task. */
  getOutput(externalId: string, opts: GetOutputOptions): Promise<string>;
  /** Stop the task if it is running. */
  stop(externalId: string): Promise<StopOutcome>;
}

export type TaskRunner = {
  getOutput(externalId: string, opts: GetOutputOptions): Promise<string>;
  stop(externalId: string): Promise<string>;
};

/** Resolve an external id (a task id, or a bound agent id) to a canonical task id. */
export function resolveTaskId(runtime: TaskRuntime, externalId: string): string {
  if (runtime.store.get(externalId)) return externalId;
  for (const [agentId, taskId] of runtime.agentTaskMap) {
    if (agentId === externalId || agentId.startsWith(externalId)) return taskId;
  }
  return externalId;
}

/** Adapter for background shell processes tracked by ProcessTracker. */
function createProcessAdapter(runtime: TaskRuntime): TaskExecutionAdapter {
  return {
    claims(externalId) {
      return runtime.tracker.getOutput(externalId) !== undefined;
    },
    async getOutput(externalId, opts) {
      const current = runtime.tracker.getOutput(externalId)!;
      if (opts.block && current.status === "running") {
        const result = await runtime.tracker.waitForCompletion(
          externalId,
          opts.timeout ?? TASK_PROCESS_WAIT_TIMEOUT_MS,
          opts.signal ?? undefined,
        );
        if (result) {
          return `Task #${externalId} (${result.status})${result.exitCode !== undefined ? ` exit code: ${result.exitCode}` : ""}\n\n${result.output}`;
        }
      }
      return `Task #${externalId} (${current.status})${current.exitCode !== undefined ? ` exit code: ${current.exitCode}` : ""}\n\n${current.output}`;
    },
    async stop(externalId) {
      const acted = await runtime.tracker.stop(externalId);
      return acted ? { acted: true, completedTaskId: externalId } : { acted: false };
    },
  };
}

/** Adapter for tasks executing as spawned subagents over the subagent bridge. */
function createSubagentAdapter(pi: ExtensionAPI, runtime: TaskRuntime, bridge: SubagentBridge): TaskExecutionAdapter {
  function bind(externalId: string): { taskId: string; agentId: string } | undefined {
    const taskId = resolveTaskId(runtime, externalId);
    const agentId = runtime.store.get(taskId)?.metadata?.agentId;
    return typeof agentId === "string" && agentId ? { taskId, agentId } : undefined;
  }
  return {
    claims(externalId) {
      return bind(externalId) !== undefined;
    },
    async getOutput(externalId, opts) {
      const { taskId, agentId } = bind(externalId)!;
      const task = runtime.store.get(taskId)!;
      if (opts.block && task.status === "in_progress") {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { unsubOk(); unsubFail(); resolve(); }, opts.timeout ?? TASK_OUTPUT_DEFAULT_TIMEOUT_MS);
          const cleanup = () => { clearTimeout(timer); resolve(); };
          const unsubOk = pi.events.on("subagents:completed", (d: unknown) => {
            if ((d as any).id === agentId) { unsubOk(); unsubFail(); cleanup(); }
          });
          const unsubFail = pi.events.on("subagents:failed", (d: unknown) => {
            if ((d as any).id === agentId) { unsubOk(); unsubFail(); cleanup(); }
          });
          const settled = runtime.store.get(externalId);
          if (settled && settled.status !== "in_progress") { unsubOk(); unsubFail(); cleanup(); }
          opts.signal?.addEventListener("abort", () => { unsubOk(); unsubFail(); cleanup(); }, { once: true });
        });
      }
      const updated = runtime.store.get(externalId) ?? task;
      return `Task #${externalId} [${updated.status}] — subagent ${agentId}`;
    },
    async stop(externalId) {
      const bound = bind(externalId);
      if (!bound || runtime.store.get(bound.taskId)?.status !== "in_progress") return { acted: false };
      await bridge.stopSubagent(bound.agentId);
      return { acted: true, completedTaskId: bound.taskId };
    },
  };
}

export function createTaskRunner(pi: ExtensionAPI, runtime: TaskRuntime, bridge: SubagentBridge): TaskRunner {
  // Process first, then subagent — preserves the original tools' lookup order.
  const adapters: TaskExecutionAdapter[] = [createProcessAdapter(runtime), createSubagentAdapter(pi, runtime, bridge)];

  function finalizeStop(completedTaskId: string, externalId: string): string {
    updateTask(runtime, completedTaskId, { status: "completed" }, "internal");
    runtime.autoClear.trackCompletion(externalId, runtime.currentTurn);
    runtime.widget.setActiveTask(externalId, false);
    runtime.widget.update();
    return `Task #${externalId} stopped successfully`;
  }

  return {
    async getOutput(externalId, opts) {
      for (const adapter of adapters) {
        if (adapter.claims(externalId)) return adapter.getOutput(externalId, opts);
      }
      const task = runtime.store.get(resolveTaskId(runtime, externalId));
      throw new Error(task
        ? `No background process for task ${externalId}`
        : `No task found with ID ${externalId}`);
    },
    async stop(externalId) {
      for (const adapter of adapters) {
        const outcome = await adapter.stop(externalId);
        if (outcome.acted) return finalizeStop(outcome.completedTaskId!, externalId);
      }
      throw new Error(`No running background process for task ${externalId}`);
    },
  };
}
