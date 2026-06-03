/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   steer_subagent       — LLM-callable: send a steering message to a running agent
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagentRuntime } from "./lifecycle/supervision.js";
export {
  formatAgentDefinitionDiagnostic,
  formatAgentDefinitionDiagnostics,
  formatInvalidAgentDefinitionMessage,
} from "./lifecycle/supervision.js";

// Expose manager via Symbol.for() global registry for cross-package access.
// Standard Node.js pattern for cross-package singletons (used by OpenTelemetry, etc.).
//
// The Symbol-key string stays "pi-subagents:manager" so the tasks bridge keeps
// interop with any concurrently-loaded pre-fork upstream build during
// the rename transition window. The manager-version guard below distinguishes the
// @panda fork (1.0.0+) from older registrations: on mismatch we emit
// `subagent.symbol.version-conflict` once and take over last-write-wins.
const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const MANAGER_VERSION = "1.0.0";
const MANAGER_VERSION_GLOBAL_KEY = "__pandaSubagentsManagerVersion" as const;

type PandaManagerGlobal = typeof globalThis & {
  [MANAGER_VERSION_GLOBAL_KEY]?: string;
};

let warnedSymbolVersionConflict = false;

function reportSymbolVersionConflict(previousVersion: string | undefined): void {
  if (warnedSymbolVersionConflict) return;
  warnedSymbolVersionConflict = true;
  console.warn(`[panda-warn] ${JSON.stringify({
    code: "subagent.symbol.version-conflict",
    ts: new Date().toISOString(),
    expectedVersion: MANAGER_VERSION,
    previousVersion: previousVersion ?? null,
    resolution: "last-write-wins",
  })}`);
}

export default function (pi: ExtensionAPI) {
  const pandaGlobal = globalThis as PandaManagerGlobal;
  const previousVersion = pandaGlobal[MANAGER_VERSION_GLOBAL_KEY];
  if (previousVersion !== undefined && previousVersion !== MANAGER_VERSION) {
    reportSymbolVersionConflict(previousVersion);
  }
  pandaGlobal[MANAGER_VERSION_GLOBAL_KEY] = MANAGER_VERSION;
  registerSubagentRuntime(pi, MANAGER_KEY);
}
