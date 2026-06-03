import { Type } from "typebox";
import { TASK_OUTPUT_DEFAULT_TIMEOUT_MS, TASK_PROCESS_WAIT_TIMEOUT_MS } from "../constants.js";
import { textResult } from "../lifecycle/store-glue.js";
import type { TaskToolDeps } from "./types.js";

export function registerOutputTool({ pi, runtime }: TaskToolDeps) {
  pi.registerTool({
    name: "TaskOutput",
    label: "TaskOutput",
    description: `- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions`,
    parameters: Type.Object({
      task_id: Type.String({ description: "The task ID to get output from" }),
      block: Type.Boolean({ description: "Whether to wait for completion", default: true }),
      timeout: Type.Number({ description: "Max wait time in ms", default: TASK_OUTPUT_DEFAULT_TIMEOUT_MS, minimum: 0, maximum: 600000 }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const { task_id, block, timeout } = params;

      const processOutput = runtime.tracker.getOutput(task_id);
      if (!processOutput) {
        let resolvedId = task_id;
        if (!runtime.store.get(resolvedId)) {
          for (const [agentId, taskId] of runtime.agentTaskMap) {
            if (agentId === task_id || agentId.startsWith(task_id)) { resolvedId = taskId; break; }
          }
        }
        const task = runtime.store.get(resolvedId);
        if (!task) throw new Error(`No task found with ID ${task_id}`);

        if (task.metadata?.agentId) {
          if (block && task.status === "in_progress") {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => { unsubOk(); unsubFail(); resolve(); }, timeout ?? TASK_OUTPUT_DEFAULT_TIMEOUT_MS);
              const cleanup = () => { clearTimeout(timer); resolve(); };
              const unsubOk = pi.events.on("subagents:completed", (d: unknown) => {
                if ((d as any).id === task.metadata?.agentId) { unsubOk(); unsubFail(); cleanup(); }
              });
              const unsubFail = pi.events.on("subagents:failed", (d: unknown) => {
                if ((d as any).id === task.metadata?.agentId) { unsubOk(); unsubFail(); cleanup(); }
              });
              const current = runtime.store.get(task_id);
              if (current && current.status !== "in_progress") { unsubOk(); unsubFail(); cleanup(); }
              signal?.addEventListener("abort", () => { unsubOk(); unsubFail(); cleanup(); }, { once: true });
            });
          }
          const updated = runtime.store.get(task_id) ?? task;
          return textResult(`Task #${task_id} [${updated.status}] — subagent ${task.metadata.agentId}`);
        }
        throw new Error(`No background process for task ${task_id}`);
      }

      if (block && processOutput.status === "running") {
        const result = await runtime.tracker.waitForCompletion(task_id, timeout ?? TASK_PROCESS_WAIT_TIMEOUT_MS, signal ?? undefined);
        if (result) {
          return textResult(
            `Task #${task_id} (${result.status})${result.exitCode !== undefined ? ` exit code: ${result.exitCode}` : ""}\n\n${result.output}`,
          );
        }
      }

      return textResult(
        `Task #${task_id} (${processOutput.status})${processOutput.exitCode !== undefined ? ` exit code: ${processOutput.exitCode}` : ""}\n\n${processOutput.output}`,
      );
    },
  });
}
