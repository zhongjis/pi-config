import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentBridge } from "../bridge/subagent-bridge.js";
import type { TaskRuntime } from "../lifecycle/store-glue.js";
import type { TaskRunner } from "../task-runner.js";

export type TaskToolDeps = {
  pi: ExtensionAPI;
  runtime: TaskRuntime;
  bridge: SubagentBridge;
  runner: TaskRunner;
};
