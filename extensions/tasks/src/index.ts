/**
 * @panda/pi-tasks — A pi extension providing Claude Code-style task tracking and coordination.
 *
 * Tools:
 *   Task   — Consolidated task tool with ops: create | update | list | get
 *
 * Commands:
 *   /tasks       — Interactive task management menu
 */

import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { installPandaWarnFileSink } from "../../lib/warn.js";
import { registerTaskRpcHandlers } from "./bridge/rpc-handlers.js";
import { createTaskRuntime, registerLifecycleEvents } from "./lifecycle/store-glue.js";
import { registerTaskTools } from "./tools/index.js";

export default function (pi: ExtensionAPI) {
  installPandaWarnFileSink(getAgentDir);
  const runtime = createTaskRuntime();

  registerTaskRpcHandlers(pi, runtime);
  registerLifecycleEvents(pi, runtime);
  registerTaskTools({ pi, runtime });
}
