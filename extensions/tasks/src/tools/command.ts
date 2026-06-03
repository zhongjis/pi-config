import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AUTO_CLEAR_DELAY } from "../constants.js";
import { updateTask } from "../lifecycle/fsm-dispatch.js";
import { buildTaskMetadata, type SessionStateContext } from "../lifecycle/store-glue.js";
import { openSettingsMenu } from "../ui/settings-menu.js";
import type { TaskToolDeps } from "./types.js";

export function registerTasksCommand({ pi, runtime }: TaskToolDeps) {
  pi.registerCommand("tasks", {
    description: "Manage tasks — view, create, clear completed",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const ui = ctx.ui;

      const mainMenu = async (): Promise<void> => {
        const tasks = runtime.store.list();
        const taskCount = tasks.length;
        const completedCount = tasks.filter(t => t.status === "completed").length;

        const choices: string[] = [
          `View all tasks (${taskCount})`,
          "Create task",
        ];
        if (completedCount > 0) choices.push(`Clear completed (${completedCount})`);
        if (taskCount > 0) choices.push(`Clear all (${taskCount})`);
        choices.push("Settings");

        const choice = await ui.select("Tasks", choices);
        if (!choice) return;

        if (choice.startsWith("View")) {
          await viewTasks();
        } else if (choice === "Create task") {
          await createTask();
        } else if (choice === "Settings") {
          await settingsMenu();
        } else if (choice.startsWith("Clear completed")) {
          runtime.store.clearCompleted();
          if (runtime.taskScope === "session") runtime.store.deleteFileIfEmpty();
          runtime.widget.update();
          await mainMenu();
        } else if (choice.startsWith("Clear all")) {
          runtime.store.clearAll();
          if (runtime.taskScope === "session") runtime.store.deleteFileIfEmpty();
          runtime.widget.update();
          await mainMenu();
        }
      };

      const viewTasks = async (): Promise<void> => {
        const tasks = runtime.store.list();
        if (tasks.length === 0) {
          await ui.select("No tasks", ["← Back"]);
          return mainMenu();
        }

        const statusIcon = (status: string) => {
          switch (status) {
            case "completed": return "✔";
            case "in_progress": return "◼";
            default: return "◻";
          }
        };

        const choices = tasks.map(t =>
          `${statusIcon(t.status)} #${t.id} [${t.status}] ${t.subject}`
        );
        choices.push("← Back");

        const selected = await ui.select("Tasks", choices);
        if (!selected || selected === "← Back") return mainMenu();

        const match = selected.match(/#(\d+)/);
        if (match) await viewTaskDetail(match[1]);
        else return viewTasks();
      };

      const viewTaskDetail = async (taskId: string): Promise<void> => {
        const task = runtime.store.get(taskId);
        if (!task) return viewTasks();

        const actions: string[] = [];
        if (task.status === "pending") actions.push("▸ Start (in_progress)");
        if (task.status === "in_progress") actions.push("✓ Complete");
        actions.push("✗ Delete");
        actions.push("← Back");

        const title = `#${task.id} [${task.status}] ${task.subject}\n${task.description}`;
        const action = await ui.select(title, actions);

        if (action === "▸ Start (in_progress)") {
          updateTask(runtime, taskId, { status: "in_progress" }, "internal");
          runtime.widget.setActiveTask(taskId);
          runtime.widget.update();
          return viewTasks();
        } else if (action === "✓ Complete") {
          updateTask(runtime, taskId, { status: "completed" }, "internal");
          runtime.autoClear.trackCompletion(taskId, runtime.currentTurn);
          runtime.widget.setActiveTask(taskId, false);
          runtime.widget.update();
          return viewTasks();
        } else if (action === "✗ Delete") {
          updateTask(runtime, taskId, { status: "deleted" }, "internal");
          runtime.widget.setActiveTask(taskId, false);
          runtime.widget.update();
          return viewTasks();
        }
        return viewTasks();
      };

      const settingsMenu = (): Promise<void> =>
        openSettingsMenu(ui, runtime.cfg, mainMenu, AUTO_CLEAR_DELAY);

      const createTask = async (): Promise<void> => {
        const subject = await ui.input("Task subject");
        if (!subject) return mainMenu();
        const description = await ui.input("Task description");
        if (!description) return mainMenu();

        const { metadata } = buildTaskMetadata(undefined, ctx as SessionStateContext);
        runtime.store.create(subject, description, undefined, metadata);
        runtime.widget.update();
        return mainMenu();
      };

      await mainMenu();
    },
  });
}
