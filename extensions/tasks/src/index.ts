/**
 * @panda/pi-tasks — A pi extension providing Claude Code-style task tracking and coordination.
 *
 * Tools:
 *   TaskCreate   — Create a structured task
 *   TaskList     — List all tasks with status
 *   TaskGet      — Get full task details
 *   TaskUpdate   — Update task fields, status, dependencies
 *   TaskOutput   — Get output from a background task process
 *   TaskStop     — Stop a running background task process
 *
 * Commands:
 *   /tasks       — Interactive task management menu
 */

import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { installPandaWarnFileSink } from "../../lib/warn.js";
import { registerTaskRpcHandlers } from "./bridge/rpc-handlers.js";
import { createTaskRuntime, registerLifecycleEvents } from "./lifecycle/store-glue.js";
import { createTaskRunner } from "./task-runner.js";
import { registerTaskTools } from "./tools/index.js";

export default function (pi: ExtensionAPI) {
  installPandaWarnFileSink(getAgentDir);
  const runtime = createTaskRuntime();
  const runner = createTaskRunner(runtime);

  registerTaskRpcHandlers(pi, runtime);
  registerLifecycleEvents(pi, runtime);
  registerTaskTools({ pi, runtime, runner });
}
