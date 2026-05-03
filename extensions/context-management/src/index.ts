import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerContextDashboard } from "./context-dashboard.js";
import { registerContextCore } from "./context-core.js";
import { registerContextPrune } from "./context-prune.js";

export default function contextManagementExtension(pi: ExtensionAPI): void {
  registerContextCore(pi);
  registerContextDashboard(pi);
  registerContextPrune(pi);
}
