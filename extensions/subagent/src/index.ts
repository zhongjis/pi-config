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

import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { installPandaWarnFileSink, pandaWarn } from "../../lib/warn.js";
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

const SUBAGENT_ORCHESTRATION_GUIDANCE = `## Subagent Orchestration

You have access to subagent tools for delegating work:
- \`Agent\` — Launch a new agent for complex, multi-step tasks. Use \`run_in_background: true\` for parallel work.
- \`get_subagent_result\` — Check status and retrieve results from background agents.
- \`steer_subagent\` — Send steering messages to redirect running agents.

Guidelines:
- For parallel work, launch multiple agents with \`run_in_background: true\` and supervise with \`get_subagent_result\`.
- Background agents require active supervision — check progress, steer if needed.
- Choose agent types that match the task (see Agent tool description for available types).`;

function reportSymbolVersionConflict(previousVersion: string | undefined): void {
  if (warnedSymbolVersionConflict) return;
  warnedSymbolVersionConflict = true;
  pandaWarn("subagent.symbol.version-conflict", {
    expectedVersion: MANAGER_VERSION,
    previousVersion: previousVersion ?? null,
    resolution: "last-write-wins",
  });
}
export default function (pi: ExtensionAPI) {
  installPandaWarnFileSink(getAgentDir);
  const pandaGlobal = globalThis as PandaManagerGlobal;
  const previousVersion = pandaGlobal[MANAGER_VERSION_GLOBAL_KEY];
  if (previousVersion !== undefined && previousVersion !== MANAGER_VERSION) {
    reportSymbolVersionConflict(previousVersion);
  }
  pandaGlobal[MANAGER_VERSION_GLOBAL_KEY] = MANAGER_VERSION;
  pi.on("before_agent_start", async (ctx) => {
    return {
      systemPrompt: (ctx.systemPrompt ?? "") + "\n\n" + SUBAGENT_ORCHESTRATION_GUIDANCE,
    };
  });
  registerSubagentRuntime(pi, MANAGER_KEY);
}
