import { registerTasksCommand } from "./command.js";
import { registerCreateTool } from "./create.js";
import { registerGetTool } from "./get.js";
import { registerListTool } from "./list.js";
import { registerOutputTool } from "./output.js";
import { registerStopTool } from "./stop.js";
import type { TaskToolDeps } from "./types.js";
import { registerUpdateTool } from "./update.js";

export function registerTaskTools(deps: TaskToolDeps) {
  registerCreateTool(deps);
  registerListTool(deps);
  registerGetTool(deps);
  registerUpdateTool(deps);
  registerOutputTool(deps);
  registerStopTool(deps);
  registerTasksCommand(deps);
}
