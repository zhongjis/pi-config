import { Type } from "typebox";
import { filterBlockers } from "../../../lib/blocker.js";
import { textResult } from "../lifecycle/store-glue.js";
import { renderTaskToolCall, renderTaskToolResult } from "./rendering.js";
import type { TaskToolDeps } from "./types.js";

export function registerGetTool({ pi, runtime }: TaskToolDeps) {
  pi.registerTool({
    name: "TaskGet",
    label: "TaskGet",
    description: `Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements

## Output

Returns full task details:
- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', or 'completed'
- **blocks**: Tasks waiting on this one to complete
- **blockedBy**: Tasks that must complete before this one can start

## Tips

- After fetching a task, verify its blockedBy list is empty before beginning work.
- Use TaskList to see all tasks in summary form.`,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to retrieve" }),
    }),

    renderCall(args, theme) {
      return renderTaskToolCall("TaskGet", args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderTaskToolResult("TaskGet", result, options, theme, context);
    },

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const task = runtime.store.get(params.taskId);
      if (!task) return Promise.resolve(textResult(`Task not found`));

      const desc = task.description.replace(/\\n/g, "\n");
      const lines: string[] = [
        `Task #${task.id}: ${task.subject}`,
        `Status: ${task.status}`,
      ];
      if (task.owner) lines.push(`Owner: ${task.owner}`);
      lines.push(`Description: ${desc}`);

	      if (task.blockedBy.length > 0) {
	        const { unsatisfied: openBlockers } = filterBlockers(task.blockedBy, runtime.store);
	        if (openBlockers.length > 0) lines.push(`Blocked by: ${openBlockers.map(id => "#" + id).join(", ")}`);
	      }
      if (task.blocks.length > 0) lines.push(`Blocks: ${task.blocks.map(id => "#" + id).join(", ")}`);

      const metaKeys = Object.keys(task.metadata);
      if (metaKeys.length > 0) lines.push(`Metadata: ${JSON.stringify(task.metadata)}`);

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });
}
