import { Type } from "typebox";
import { TASK_OUTPUT_DEFAULT_TIMEOUT_MS } from "../constants.js";
import { textResult } from "../lifecycle/store-glue.js";
import { renderTaskToolCall, renderTaskToolResult } from "./rendering.js";
import type { TaskToolDeps } from "./types.js";

export function registerOutputTool({ pi, runner }: TaskToolDeps) {
  pi.registerTool({
    name: "TaskOutput",
    label: "TaskOutput",
    description: `- Retrieves output from a tracked background process
- Takes a task_id parameter identifying the task
- Returns the process output along with status information
- Use block=true (default) to wait for process completion
- Use block=false for a non-blocking check of current status
- Task IDs can be found using the /tasks command`,
    parameters: Type.Object({
      task_id: Type.String({ description: "The task ID to get output from" }),
      block: Type.Boolean({ description: "Whether to wait for completion", default: true }),
      timeout: Type.Number({ description: "Max wait time in ms", default: TASK_OUTPUT_DEFAULT_TIMEOUT_MS, minimum: 0, maximum: 600000 }),
    }),

    renderCall(args, theme) {
      return renderTaskToolCall("TaskOutput", args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderTaskToolResult("TaskOutput", result, options, theme, context);
    },

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
