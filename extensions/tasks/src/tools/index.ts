import { registerTasksCommand } from "./command.js";
import { registerTaskTool } from "./task.js";
import type { TaskToolDeps } from "./types.js";

export function registerTaskTools(deps: TaskToolDeps) {
  registerTaskTool(deps);
  registerTasksCommand(deps);
}
