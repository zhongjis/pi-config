import { Type } from "typebox";
import { TASK_OUTPUT_DEFAULT_TIMEOUT_MS } from "../constants.js";
import { textResult } from "../lifecycle/store-glue.js";
import type { TaskToolDeps } from "./types.js";

export function registerOutputTool({ pi, runner }: TaskToolDeps) {
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
      return textResult(await runner.getOutput(task_id, {
        block,
        timeout: timeout ?? TASK_OUTPUT_DEFAULT_TIMEOUT_MS,
        signal: signal ?? undefined,
      }));
    },
  });
}
