/**
 * research-delegation.ts — `delegate_research`, the trusted inline tool that
 * lets a delegation-enabled Subagent run one read-only research Subagent through
 * the root AgentManager ([ADR 0007](../../../docs/adr/0007-nested-research-through-a-root-manager-bridge.md)).
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getAgentConfig, getAllTypes } from "./agent-types.js";
import { resolveNestedTargets } from "./delegation-policy.js";
import { getStatusNote } from "./status-note.js";
import type { AgentConfig, InterruptionCause } from "./types.js";

export const DELEGATE_RESEARCH_TOOL_NAME = "delegate_research";

export interface NestedResearchRequest {
  type: string;
  prompt: string;
  description: string;
  /** The parent's effective working directory. */
  cwd: string;
  signal?: AbortSignal;
}

export interface NestedResearchResult {
  agentId?: string;
  type: string;
  status: string;
  text: string;
  error?: string;
  interruptionCause?: InterruptionCause;
}

/** Root-manager bridge supplied by `AgentManager`; it never throws. */
export type NestedSpawn = (request: NestedResearchRequest) => Promise<NestedResearchResult>;

/** Re-resolved on every call: agent configurations may reload mid-run. */
export function currentTargets(parent: Pick<AgentConfig, "name" | "delegationRules"> | undefined, isGuardedBash: (type: string) => boolean): string[] {
  if (!parent) return [];
  const configs = getAllTypes().map(getAgentConfig).filter((config): config is AgentConfig => config !== undefined);
  return resolveNestedTargets(parent, configs, isGuardedBash);
}

function resultText(result: NestedResearchResult) {
  const header = [`agentId: ${result.agentId ?? "none"}`, `type: ${result.type}`, `status: ${result.status}${getStatusNote(result.status, result.interruptionCause)}`];
  if (result.error) header.push(`error: ${result.error}`);
  const { text: _text, ...details } = result;
  return { content: [{ type: "text" as const, text: `${header.join("\n")}\n\n${result.text || "(no output)"}` }], details };
}

export function createDelegateResearchTool(
  parentType: string,
  cwd: string,
  spawn: NestedSpawn,
  isGuardedBash: (type: string) => boolean,
) {
  const targets = currentTargets(getAgentConfig(parentType), isGuardedBash);
  return defineTool({
    name: DELEGATE_RESEARCH_TOOL_NAME,
    label: "Delegate research",
    description: `Run one read-only research agent on a self-contained question and wait for its final answer.
Permitted subagent_type values: ${targets.join(", ") || "none"}.
The result returns to you only; neither the user nor your caller sees it. You remain responsible for checking its evidence before you rely on it.
Each call starts a fresh agent that has not seen this conversation. Calls in one response run concurrently; at most 3 may run at once, and extra calls fail. There is no background run, resume, or steering.`,
    parameters: Type.Object({
      subagent_type: Type.String({ description: "A permitted research agent type from this tool's description." }),
      prompt: Type.String({ description: "The self-contained research question, with the context the agent needs." }),
      description: Type.String({ description: "A short (3-5 word) description of the task (shown in UI)." }),
    }),
    execute: async (_toolCallId, params, signal) => {
      try {
        const permitted = currentTargets(getAgentConfig(parentType), isGuardedBash);
        const type = permitted.find((name) => name.toLowerCase() === params.subagent_type.trim().toLowerCase());
        if (!type) {
          return resultText({
            type: params.subagent_type,
            status: "denied",
            text: "",
            error: `"${params.subagent_type}" is not a permitted research target. Permitted: ${permitted.join(", ") || "none"}.`,
          });
        }
        return resultText(await spawn({ type, prompt: params.prompt, description: params.description, cwd, signal }));
      } catch (error) {
        return resultText({ type: params.subagent_type, status: "error", text: "", error: error instanceof Error ? error.message : String(error) });
      }
    },
  });
}
