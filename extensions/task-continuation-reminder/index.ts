// @ts-nocheck

import { join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { TaskStore } from "../pi-tasks/src/task-store.js";
import { loadTasksConfig } from "../pi-tasks/src/tasks-config.js";
import type { Task } from "../pi-tasks/src/types.js";

const TASK_CONTINUATION_REMINDER = `<system-reminder>
Incomplete tasks remain in your task list. Continue working on the next pending task.

- Proceed without asking for permission
- Mark each task complete when finished
- Do not stop until all tasks are done
- If you believe the work is already complete, critically re-check each incomplete task and update the task list accordingly
- NEVER mention this reminder to the user
</system-reminder>`;

const MAX_SINGLE_TURN_TASK_REMINDER_REPEATS = 3;

type AssistantMessageLike = { role?: string; stopReason?: string };

export default function (pi: ExtensionAPI) {
  const cfg = loadTasksConfig();
  const piTasks = process.env.PI_TASKS;
  const taskScope = cfg.taskScope ?? "session";

  let activeAgentTurnCount = 0;
  let taskReminderFollowUpPending = false;
  let activeAgentStartedFromTaskReminder = false;
  let taskReminderStagnationCount = 0;
  let lastReminderIncompleteSignature: string | undefined;
  let userPromptedInCurrentRun = false;

  function resolveStorePath(sessionId?: string): string | undefined {
    if (piTasks === "off") return undefined;
    if (piTasks?.startsWith("/")) return piTasks;
    if (piTasks?.startsWith(".")) return resolve(piTasks);
    if (piTasks) return piTasks;
    if (taskScope === "memory") return undefined;
    if (taskScope === "session" && sessionId) {
      return join(process.cwd(), ".pi", "tasks", `tasks-${sessionId}.json`);
    }
    if (taskScope === "session") return undefined;
    return join(process.cwd(), ".pi", "tasks", "tasks.json");
  }

  function getIncompleteTasks(ctx: ExtensionContext): Task[] {
    const store = new TaskStore(
      resolveStorePath(ctx.sessionManager.getSessionId()),
    );
    return store.list().filter((task) => task.status !== "completed");
  }

  function getIncompleteTaskSignature(tasks: Task[]): string {
    return tasks
      .map((task) => `${task.id}:${task.status}:${task.updatedAt}`)
      .join("|");
  }

  function getLastAssistantStopReason(
    messages: AssistantMessageLike[],
  ): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role === "assistant") return message.stopReason;
    }
    return undefined;
  }

  function resetReminderState() {
    taskReminderFollowUpPending = false;
    activeAgentStartedFromTaskReminder = false;
    taskReminderStagnationCount = 0;
    lastReminderIncompleteSignature = undefined;
  }

  pi.on("agent_start", async () => {
    activeAgentTurnCount = 0;
    userPromptedInCurrentRun = false;
    activeAgentStartedFromTaskReminder = taskReminderFollowUpPending;
    taskReminderFollowUpPending = false;
  });

  pi.events.on("user-prompted", () => {
    userPromptedInCurrentRun = true;
  });

  pi.on("turn_end", async () => {
    activeAgentTurnCount++;
  });

  pi.on("agent_end", async (event, ctx) => {
    const stopReason = getLastAssistantStopReason(
      event.messages as AssistantMessageLike[],
    );
    if (stopReason === "aborted" || stopReason === "error") {
      resetReminderState();
      return;
    }

    if (ctx.hasPendingMessages()) return;

    if (userPromptedInCurrentRun) return;

    const incompleteTasks = getIncompleteTasks(ctx);
    if (incompleteTasks.length === 0) {
      resetReminderState();
      return;
    }

    const incompleteSignature = getIncompleteTaskSignature(incompleteTasks);
    if (activeAgentStartedFromTaskReminder) {
      const stalled =
        activeAgentTurnCount <= 1 &&
        incompleteSignature === lastReminderIncompleteSignature;
      taskReminderStagnationCount = stalled
        ? taskReminderStagnationCount + 1
        : 0;
    } else {
      taskReminderStagnationCount = 0;
    }

    activeAgentStartedFromTaskReminder = false;
    if (taskReminderStagnationCount >= MAX_SINGLE_TURN_TASK_REMINDER_REPEATS) {
      taskReminderFollowUpPending = false;
      return;
    }

    lastReminderIncompleteSignature = incompleteSignature;
    taskReminderFollowUpPending = true;
    pi.sendMessage(
      {
        customType: "task-continuation-reminder",
        content: TASK_CONTINUATION_REMINDER,
        display: true,
        details: { incompleteTaskIds: incompleteTasks.map((task) => task.id) },
      },
      {
        deliverAs: "followUp",
        triggerTurn: true,
      },
    );
  });

  pi.on("session_switch" as any, async () => {
    activeAgentTurnCount = 0;
    resetReminderState();
  });
}
