/** Process-only seam used by TaskOutput and TaskStop. */

import { TASK_PROCESS_WAIT_TIMEOUT_MS } from "./constants.js";
import { updateTask } from "./lifecycle/fsm-dispatch.js";
import type { TaskRuntime } from "./lifecycle/store-glue.js";

export interface GetOutputOptions {
  block: boolean;
  timeout: number;
  signal?: AbortSignal;
}

export type TaskRunner = {
  getOutput(taskId: string, opts: GetOutputOptions): Promise<string>;
  stop(taskId: string): Promise<string>;
};

export function createTaskRunner(runtime: TaskRuntime): TaskRunner {
  function finalizeStop(taskId: string): string {
    updateTask(runtime, taskId, { status: "completed" }, "internal");
    runtime.autoClear.trackCompletion(taskId, runtime.currentTurn);
    runtime.widget.setActiveTask(taskId, false);
    runtime.widget.update();
    return `Task #${taskId} stopped successfully`;
  }

  return {
    async getOutput(taskId, opts) {
      const current = runtime.tracker.getOutput(taskId);
      if (!current) {
        throw new Error(runtime.store.get(taskId)
          ? `No background process for task ${taskId}`
          : `No task found with ID ${taskId}`);
      }
      if (opts.block && current.status === "running") {
        const result = await runtime.tracker.waitForCompletion(
          taskId,
          opts.timeout ?? TASK_PROCESS_WAIT_TIMEOUT_MS,
          opts.signal ?? undefined,
        );
        if (result) {
          return `Task #${taskId} (${result.status})${result.exitCode !== undefined ? ` exit code: ${result.exitCode}` : ""}\n\n${result.output}`;
        }
      }
      return `Task #${taskId} (${current.status})${current.exitCode !== undefined ? ` exit code: ${current.exitCode}` : ""}\n\n${current.output}`;
    },
    async stop(taskId) {
      if (!await runtime.tracker.stop(taskId)) {
        throw new Error(`No running background process for task ${taskId}`);
      }
      return finalizeStop(taskId);
    },
  };
}
