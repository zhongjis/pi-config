import { Type } from "typebox";
import { filterBlockers } from "../../../lib/blocker.js";
import { textResult } from "../lifecycle/store-glue.js";
import type { Task } from "../types.js";
import { renderTaskToolCall, renderTaskToolResult } from "./rendering.js";
import type { TaskToolDeps } from "./types.js";

type TaskGroup = {
  heading: "Running" | "Ready" | "Blocked" | "Completed";
  tasks: Task[];
};

function hasUnsatisfiedBlockers(task: Task, store: { get(id: string): Task | undefined }): boolean {
  if (task.blockedBy.length === 0) return false;
  return filterBlockers(task.blockedBy, store).unsatisfied.length > 0;
}

function groupTasks(tasks: Task[], store: { get(id: string): Task | undefined }): TaskGroup[] {
  const running: Task[] = [];
  const ready: Task[] = [];
  const blocked: Task[] = [];
  const completed: Task[] = [];

  for (const task of tasks) {
    if (task.status === "in_progress") {
      running.push(task);
    } else if (task.status === "completed") {
      completed.push(task);
    } else if (!task.owner && !hasUnsatisfiedBlockers(task, store)) {
      ready.push(task);
    } else {
      blocked.push(task);
    }
  }

  const groups: TaskGroup[] = [
    { heading: "Running", tasks: running },
    { heading: "Ready", tasks: ready },
    { heading: "Blocked", tasks: blocked },
    { heading: "Completed", tasks: completed },
  ];
  return groups.filter(group => group.tasks.length > 0);
}

function formatTaskLine(task: Task, store: { get(id: string): Task | undefined }): string {
  let line = `#${task.id} [${task.status}] ${task.subject}`;
  if (task.owner) line += ` (${task.owner})`;
  const agentType = task.metadata.agentType;
  if (task.status === "pending" && !task.owner && typeof agentType === "string" && agentType.trim() !== "" && !hasUnsatisfiedBlockers(task, store)) {
    line += ` [executable: ${agentType}]`;
  }
  if (task.blockedBy.length > 0) {
    const { unsatisfied: openBlockers } = filterBlockers(task.blockedBy, store);
    if (openBlockers.length > 0) line += ` [blocked by ${openBlockers.map(id => "#" + id).join(", ")}]`;
  }
  return line;
}

export function registerListTool({ pi, runtime }: TaskToolDeps) {
  pi.registerTool({
    name: "TaskList",
    label: "TaskList",
    description: `Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see ready tasks (status: 'pending', no owner, not blocked) before choosing work
- To check overall progress on the project
- To find tasks that are blocked, owner-assigned, or need dependencies resolved
- After completing a task, to check for newly unblocked work or claim the next available task
- Prefer tasks in the Ready section; preserve ID order within each section when choosing among similar tasks

## Output

Returns tasks grouped into Running, Ready, Blocked, and Completed sections when tasks exist:
- **Running**: tasks with status 'in_progress'
- **Ready**: pending tasks with no owner and no unsatisfied blockers
- **Blocked**: pending tasks with an owner or unsatisfied blockers
- **Completed**: tasks with status 'completed'
- Ready tasks with **metadata.agentType** are marked executable for TaskExecute
- Each task line includes **id**, **status**, **subject**, owner when assigned, and open blockers when present
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

      const groups = groupTasks(tasks, runtime.store);
      const lines = groups.flatMap(group => [
        group.heading,
        ...group.tasks.map(task => formatTaskLine(task, runtime.store)),
      ]);

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });
}
