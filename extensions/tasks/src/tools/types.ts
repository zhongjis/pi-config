import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskRuntime } from "../lifecycle/store-glue.js";

export type TaskToolDeps = {
  pi: ExtensionAPI;
  runtime: TaskRuntime;
};
