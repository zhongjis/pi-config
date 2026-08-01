import { Type } from "typebox";
import { filterBlockers } from "../../../lib/blocker.js";
import { type TaskUpdateFields, updateTask } from "../lifecycle/fsm-dispatch.js";
import { buildTaskMetadata, type SessionStateContext, sanitizeUserMetadata, textResult } from "../lifecycle/store-glue.js";
import type { Task } from "../types.js";
import { TASK_TOOL_DESCRIPTION } from "./description.js";
import { renderTaskToolCall, renderTaskToolResult } from "./rendering.js";
import type { TaskToolDeps } from "./types.js";

/** One item in a `create` batch. */
type CreateItem = { subject?: unknown; description?: unknown; activeForm?: unknown; metadata?: Record<string, any> };
/** One item in an `update` batch. */
type UpdateItem = {
  taskId?: unknown;
  status?: unknown;
  subject?: unknown;
  description?: unknown;
  activeForm?: unknown;
  owner?: unknown;
  metadata?: Record<string, any>;
  addBlocks?: unknown;
  addBlockedBy?: unknown;
};

function errorResult(msg: string) {
  return { ...textResult(msg), isError: true as const };
}

// ---------------------------------------------------------------------------
// list / get (output identical to the former TaskList / TaskGet tools)
// ---------------------------------------------------------------------------

type TaskStore = { get(id: string): Task | undefined };
type TaskGroup = { heading: "Running" | "Ready" | "Blocked" | "Completed"; tasks: Task[] };

function hasUnsatisfiedBlockers(task: Task, store: TaskStore): boolean {
  if (task.blockedBy.length === 0) return false;
  return filterBlockers(task.blockedBy, store).unsatisfied.length > 0;
}

function groupTasks(tasks: Task[], store: TaskStore): TaskGroup[] {
  const running: Task[] = [];
  const ready: Task[] = [];
  const blocked: Task[] = [];
  const completed: Task[] = [];

  for (const task of tasks) {
    if (task.status === "in_progress") running.push(task);
    else if (task.status === "completed") completed.push(task);
    else if (!task.owner && !hasUnsatisfiedBlockers(task, store)) ready.push(task);
    else blocked.push(task);
  }

  const groups: TaskGroup[] = [
    { heading: "Running", tasks: running },
    { heading: "Ready", tasks: ready },
    { heading: "Blocked", tasks: blocked },
    { heading: "Completed", tasks: completed },
  ];
  return groups.filter(group => group.tasks.length > 0);
}

function formatTaskLine(task: Task, store: TaskStore): string {
  let line = `#${task.id} [${task.status}] ${task.subject}`;
  if (task.owner) line += ` (${task.owner})`;
  if (task.blockedBy.length > 0) {
    const { unsatisfied: openBlockers } = filterBlockers(task.blockedBy, store);
    if (openBlockers.length > 0) line += ` [blocked by ${openBlockers.map(id => "#" + id).join(", ")}]`;
  }
  return line;
}

function renderList(store: { list(): Task[]; get(id: string): Task | undefined }): string {
  const tasks = store.list();
  if (tasks.length === 0) return "No tasks found";
  const groups = groupTasks(tasks, store);
  return groups
    .flatMap(group => [group.heading, ...group.tasks.map(task => formatTaskLine(task, store))])
    .join("\n");
}

function renderGet(store: TaskStore, taskId: string): string {
  const task = store.get(taskId);
  if (!task) return "Task not found";

  const desc = task.description.replace(/\\n/g, "\n");
  const lines: string[] = [`Task #${task.id}: ${task.subject}`, `Status: ${task.status}`];
  if (task.owner) lines.push(`Owner: ${task.owner}`);
  lines.push(`Description: ${desc}`);

  if (task.blockedBy.length > 0) {
    const { unsatisfied: openBlockers } = filterBlockers(task.blockedBy, store);
    if (openBlockers.length > 0) lines.push(`Blocked by: ${openBlockers.map(id => "#" + id).join(", ")}`);
  }
  if (task.blocks.length > 0) lines.push(`Blocks: ${task.blocks.map(id => "#" + id).join(", ")}`);

  const metaKeys = Object.keys(task.metadata);
  if (metaKeys.length > 0) lines.push(`Metadata: ${JSON.stringify(task.metadata)}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// create (batch, all-or-nothing)
// ---------------------------------------------------------------------------

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function pluralTasks(n: number): string {
  return `${n} task${n === 1 ? "" : "s"}`;
}

function executeCreate(
  runtime: TaskToolDeps["runtime"],
  items: CreateItem[] | undefined,
  ctx: SessionStateContext | undefined,
) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Task create requires a non-empty `tasks` array");
  }
  // Validate every item before applying anything (all-or-nothing).
  items.forEach((item, index) => {
    if (!nonEmptyString(item.subject)) throw new Error(`Task create item ${index + 1} is missing a subject`);
    if (!nonEmptyString(item.description)) throw new Error(`Task create item ${index + 1} is missing a description`);
  });

  runtime.autoClear.resetBatchCountdown();

  const created: Array<{ id: string; subject: string }> = [];
  for (const item of items) {
    const { metadata } = buildTaskMetadata(item.metadata, ctx ?? (runtime.latestCtx as SessionStateContext | undefined));
    const activeForm = nonEmptyString(item.activeForm) ? item.activeForm : undefined;
    const task = runtime.store.create(item.subject as string, item.description as string, activeForm, metadata);
    created.push({ id: task.id, subject: task.subject });
  }
  runtime.widget.update();

  const header = `Created ${pluralTasks(created.length)}: ${created.map(t => `#${t.id}`).join(", ")}`;
  const detail = created.map(t => `#${t.id}: ${t.subject}`).join("\n");
  return textResult(`${header}\n${detail}`);
}

// ---------------------------------------------------------------------------
// update (batch, best-effort per-item report)
// ---------------------------------------------------------------------------

function applyUpdateSideEffects(runtime: TaskToolDeps["runtime"], taskId: string, status: unknown) {
  if (status === "in_progress") {
    runtime.widget.setActiveTask(taskId);
    runtime.autoClear.resetBatchCountdown();
  } else if (status === "pending") {
    runtime.autoClear.resetBatchCountdown();
  } else if (status === "completed" || status === "deleted") {
    runtime.widget.setActiveTask(taskId, false);
    if (status === "completed") runtime.autoClear.trackCompletion(taskId, runtime.currentTurn);
  }
}

function executeUpdate(runtime: TaskToolDeps["runtime"], items: UpdateItem[] | undefined) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Task update requires a non-empty `tasks` array");
  }
  items.forEach((item, index) => {
    if (!nonEmptyString(item.taskId)) throw new Error(`Task update item ${index + 1} is missing a taskId`);
  });

  const applied: string[] = [];
  const rejected: string[] = [];

  for (const item of items) {
    const taskId = item.taskId as string;
    const { taskId: _omit, ...rawFields } = item;
    const nextFields: TaskUpdateFields = {
      ...(rawFields as Record<string, unknown>),
      status: rawFields.status as TaskUpdateFields["status"],
    };
    const warnings: string[] = [];

    if (rawFields.metadata !== undefined) {
      const sanitized = sanitizeUserMetadata(rawFields.metadata);
      nextFields.metadata = sanitized.metadata;
      if (sanitized.ignoredKeys.length > 0) warnings.push(`reserved metadata keys ignored: ${sanitized.ignoredKeys.join(", ")}`);
    }

    try {
      const { task, changedFields, warnings: updateWarnings } = updateTask(runtime, taskId, nextFields, "agent");
      warnings.push(...updateWarnings);

      if (!task && changedFields.length === 0) {
        rejected.push(`#${taskId} (not found)`);
        continue;
      }

      applyUpdateSideEffects(runtime, taskId, rawFields.status);
      const fieldSummary = changedFields.length > 0 ? changedFields.join(", ") : "no change";
      applied.push(`#${taskId} (${fieldSummary})${warnings.length > 0 ? ` [warning: ${warnings.join("; ")}]` : ""}`);
    } catch (err) {
      rejected.push(`#${taskId} (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  runtime.widget.update();

  const lines: string[] = [];
  if (applied.length > 0) lines.push(`Updated ${pluralTasks(applied.length)}: ${applied.join(", ")}`);
  if (rejected.length > 0) lines.push(`Rejected ${pluralTasks(rejected.length)}: ${rejected.join(", ")}`);

  const msg = lines.join("\n");
  // Hard error only when nothing applied (mirrors the former single-update throw).
  return applied.length === 0 ? errorResult(msg) : textResult(msg);
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export function registerTaskTool({ pi, runtime }: TaskToolDeps) {
  pi.registerTool({
    name: "Task",
    label: "Task",
    description: TASK_TOOL_DESCRIPTION,
    promptGuidelines: [
      "Track multi-step work with the Task tool: `op:create` (batch) to add tasks, `op:update` to change status/dependencies.",
      "Mark a task in_progress before starting and completed when done; use `op:list` to find the next ready task.",
    ],
    parameters: Type.Object({
      op: Type.Unsafe<"create" | "update" | "list" | "get">({
        type: "string",
        enum: ["create", "update", "list", "get"],
        description: "The operation to perform.",
      }),
      tasks: Type.Optional(Type.Array(Type.Object({
        taskId: Type.Optional(Type.String({ description: "Existing task ID (update only)" })),
        subject: Type.Optional(Type.String({ description: "Brief imperative title (create: required)" })),
        description: Type.Optional(Type.String({ description: "Detailed context and acceptance criteria (create: required)" })),
        activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in the spinner when in_progress" })),
        status: Type.Optional(Type.Unsafe<"pending" | "in_progress" | "completed" | "deleted">({
          type: "string",
          enum: ["pending", "in_progress", "completed", "deleted"],
          description: "New status (update only)",
        })),
        owner: Type.Optional(Type.String({ description: "Task owner / claimant (update only)" })),
        metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary metadata; update merges keys (null deletes)" })),
        addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this task blocks (update only)" })),
        addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task (update only)" })),
      }, { additionalProperties: false }), { description: "Batch payload for op:create and op:update (one entry per task)" })),
      taskId: Type.Optional(Type.String({ description: "Target task ID for op:get" })),
    }),

    renderCall(args, theme) {
      return renderTaskToolCall(args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderTaskToolResult(result, options, theme, context);
    },

    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const op = (params as { op?: string }).op;
      switch (op) {
        case "create":
          return Promise.resolve(executeCreate(
            runtime,
            (params as { tasks?: CreateItem[] }).tasks,
            (ctx ?? runtime.latestCtx) as SessionStateContext | undefined,
          ));
        case "update":
          return Promise.resolve(executeUpdate(runtime, (params as { tasks?: UpdateItem[] }).tasks));
        case "list":
          return Promise.resolve(textResult(renderList(runtime.store)));
        case "get": {
          const taskId = (params as { taskId?: unknown }).taskId;
          if (!nonEmptyString(taskId)) throw new Error("Task get requires a `taskId`");
          return Promise.resolve(textResult(renderGet(runtime.store, taskId)));
        }
        default:
          throw new Error(`Unknown Task op: ${String(op)} (expected create, update, list, or get)`);
      }
    },
  });
}
