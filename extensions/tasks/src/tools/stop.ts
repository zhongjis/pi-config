import { Type } from "typebox";
import { updateTask } from "../lifecycle/fsm-dispatch.js";
import { textResult } from "../lifecycle/store-glue.js";
import type { TaskToolDeps } from "./types.js";

export function registerStopTool({ pi, runtime, bridge }: TaskToolDeps) {
  pi.registerTool({
    name: "TaskStop",
    label: "TaskStop",
    description: `
- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task`,
    parameters: Type.Object({
      task_id: Type.Optional(Type.String({ description: "The ID of the background task to stop" })),
      shell_id: Type.Optional(Type.String({ description: "Deprecated: use task_id instead" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const taskId = params.task_id ?? params.shell_id;
      if (!taskId) throw new Error("task_id is required");

      const stopped = await runtime.tracker.stop(taskId);
      if (!stopped) {
        let resolvedId = taskId;
        if (!runtime.store.get(resolvedId)) {
          for (const [agentId, tId] of runtime.agentTaskMap) {
            if (agentId === taskId || agentId.startsWith(taskId)) { resolvedId = tId; break; }
          }
        }
        const task = runtime.store.get(resolvedId);
        if (task?.metadata?.agentId && task.status === "in_progress") {
          updateTask(runtime, resolvedId, { status: "completed" }, "internal");
          runtime.autoClear.trackCompletion(taskId, runtime.currentTurn);
          await bridge.stopSubagent(task.metadata.agentId);
          runtime.widget.setActiveTask(taskId, false);
          runtime.widget.update();
          return textResult(`Task #${taskId} stopped successfully`);
        }
        throw new Error(`No running background process for task ${taskId}`);
      }

      updateTask(runtime, taskId, { status: "completed" }, "internal");
      runtime.autoClear.trackCompletion(taskId, runtime.currentTurn);
      runtime.widget.setActiveTask(taskId, false);
      runtime.widget.update();
      return textResult(`Task #${taskId} stopped successfully`);
    },
  });
}
