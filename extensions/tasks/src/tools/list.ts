import { Type } from "typebox";
import { filterBlockers } from "../../../lib/blocker.js";
import { TASK_STATUS_ORDER } from "../constants.js";
import { textResult } from "../lifecycle/store-glue.js";
import { renderTaskToolCall, renderTaskToolResult } from "./rendering.js";
import type { TaskToolDeps } from "./types.js";

export function registerListTool({ pi, runtime }: TaskToolDeps) {
  pi.registerTool({
    name: "TaskList",
    label: "TaskList",
    description: `Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see what tasks are available to work on (status: 'pending', no owner, not blocked)
- To check overall progress on the project
- To find tasks that are blocked and need dependencies resolved
- After completing a task, to check for newly unblocked work or claim the next available task
- **Prefer working on tasks in ID order** (lowest ID first) when multiple tasks are available, as earlier tasks often set up context for later ones

## Output

Returns a summary of each task:
- **id**: Task identifier (use with TaskGet, TaskUpdate)
- **subject**: Brief description of the task
- **status**: 'pending', 'in_progress', or 'completed'
- **owner**: Agent ID if assigned, empty if available
- **blockedBy**: List of open task IDs that must be resolved first (tasks with blockedBy cannot be claimed until dependencies resolve)

Use TaskGet with a specific task ID to view full details including description and comments.`,
    parameters: Type.Object({}),

    renderCall(args, theme) {
      return renderTaskToolCall("TaskList", args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderTaskToolResult("TaskList", result, options, theme, context);
    },

    execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const tasks = runtime.store.list();
      if (tasks.length === 0) return Promise.resolve(textResult("No tasks found"));

      const statusOrder = TASK_STATUS_ORDER;
      const sorted = [...tasks].sort((a, b) => {
        const so = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
        if (so !== 0) return so;
        return Number(a.id) - Number(b.id);
      });

      const lines = sorted.map(task => {
	        let line = `#${task.id} [${task.status}] ${task.subject}`;
	        if (task.owner) line += ` (${task.owner})`;
	        if (task.blockedBy.length > 0) {
	          const { unsatisfied: openBlockers } = filterBlockers(task.blockedBy, runtime.store);
	          if (openBlockers.length > 0) line += ` [blocked by ${openBlockers.map(id => "#" + id).join(", ")}]`;
	        }
	        return line;
      });

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });
}
