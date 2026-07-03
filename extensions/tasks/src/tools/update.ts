import { Type } from "typebox";
import { type TaskUpdateFields, updateTask } from "../lifecycle/fsm-dispatch.js";
import { sanitizeUserMetadata, textResult } from "../lifecycle/store-glue.js";
import { renderTaskToolCall, renderTaskToolResult } from "./rendering.js";
import type { TaskToolDeps } from "./types.js";

export function registerUpdateTool({ pi, runtime }: TaskToolDeps) {
  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    description: `Use this tool to update a task in the task list.

## When to Use This Tool

**Before starting work on a task:**
- Mark it in_progress BEFORE beginning — do not start work without updating status first
- After resolving, call TaskList to find your next task

**Mark tasks as resolved:**
- When you have completed the work described in a task
- When a task is no longer needed or has been superseded
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- After resolving, call TaskList to find your next task

- ONLY mark a task as completed when you have FULLY accomplished it
- If you encounter errors, blockers, or cannot finish, keep the task as in_progress
- When blocked, create a new task describing what needs to be resolved
- Never mark a task as completed if:
  - Tests are failing
  - Implementation is partial
  - You encountered unresolved errors
  - You couldn't find necessary files or dependencies

**Delete tasks:**
- When a task is no longer relevant or was created in error
- Setting status to \`deleted\` permanently removes the task

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks

## Fields You Can Update

- **status**: The task status (see Status Workflow below)
- **subject**: Change the task title (imperative form, e.g., "Run tests")
- **description**: Change the task description
- **activeForm**: Present continuous form shown in spinner when in_progress (e.g., "Running tests")
- **owner**: Change the task owner (agent name)
- **metadata**: Merge metadata keys into the task (set a key to null to delete it)
- **addBlocks**: Mark tasks that cannot start until this one completes
- **addBlockedBy**: Mark tasks that must complete before this one can start

## Status Workflow

Status progresses: \`pending\` → \`in_progress\` → \`completed\`

Use \`deleted\` to permanently remove a task.

## Staleness

Make sure to read a task's latest state using \`TaskGet\` before updating it.

## Examples

Mark task as in progress when starting work:
\`\`\`json
{"taskId": "1", "status": "in_progress"}
\`\`\`

Mark task as completed after finishing work:
\`\`\`json
{"taskId": "1", "status": "completed"}
\`\`\`

Delete a task:
\`\`\`json
{"taskId": "1", "status": "deleted"}
\`\`\`

Claim a task by setting owner:
\`\`\`json
{"taskId": "1", "owner": "my-name"}
\`\`\`

Set up task dependencies:
\`\`\`json
{"taskId": "2", "addBlockedBy": ["1"]}
\`\`\``,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to update" }),
      status: Type.Optional(Type.Unsafe<"pending" | "in_progress" | "completed" | "deleted">({
        type: "string",
        enum: ["pending", "in_progress", "completed", "deleted"],
        description: "New status for the task",
      })),
      subject: Type.Optional(Type.String({ description: "New subject for the task" })),
      description: Type.Optional(Type.String({ description: "New description for the task" })),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress" })),
      owner: Type.Optional(Type.String({ description: "New owner for the task" })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Metadata keys to merge into the task. Set a key to null to delete it." })),
      addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that this task blocks" })),
      addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
    }),

    renderCall(args, theme) {
      return renderTaskToolCall("TaskUpdate", args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderTaskToolResult("TaskUpdate", result, options, theme, context);
    },

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { taskId, ...fields } = params;
      const nextFields: TaskUpdateFields = {
        ...fields,
        status: fields.status as TaskUpdateFields["status"],
      };
      const ignoredMetadataKeys: string[] = [];

      if (fields.metadata !== undefined) {
        const sanitized = sanitizeUserMetadata(fields.metadata);
        nextFields.metadata = sanitized.metadata;
        ignoredMetadataKeys.push(...sanitized.ignoredKeys);
      }

      const { task, changedFields, warnings } = updateTask(runtime, taskId, nextFields, "agent");

      if (ignoredMetadataKeys.length > 0) {
        warnings.push(`reserved metadata keys ignored: ${ignoredMetadataKeys.join(", ")}`);
      }

      if (changedFields.length === 0 && !task) {
        return Promise.resolve(textResult(`Task #${taskId} not found`));
      }

      if (fields.status === "in_progress") {
        runtime.widget.setActiveTask(taskId);
        runtime.autoClear.resetBatchCountdown();
      } else if (fields.status === "pending") {
        runtime.autoClear.resetBatchCountdown();
      } else if (fields.status === "completed" || fields.status === "deleted") {
        runtime.widget.setActiveTask(taskId, false);
        if (fields.status === "completed") runtime.autoClear.trackCompletion(taskId, runtime.currentTurn);
      }

      runtime.widget.update();
      let msg = `Updated task #${taskId} ${changedFields.join(", ")}`;
      if (warnings.length > 0) msg += ` (warning: ${warnings.join("; ")})`;
      return Promise.resolve(textResult(msg));
    },
  });
}
